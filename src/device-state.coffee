Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
fs = Promise.promisifyAll(require('fs'))
express = require 'express'
bodyParser = require 'body-parser'
hostConfig = require './host-config'
network = require './network'
execAsync = Promise.promisify(require('child_process').exec)
mkdirp = Promise.promisify(require('mkdirp'))
path = require 'path'
rimraf = Promise.promisify(require('rimraf'))

constants = require './lib/constants'
validation = require './lib/validation'
systemd = require './lib/systemd'
updateLock = require './lib/update-lock'
{ singleToMulticontainerApp } = require './lib/migration'
{ ENOENT, EISDIR, NotFoundError, UpdatesLockedError } = require './lib/errors'

{ DeviceConfig } = require './device-config'
ApplicationManager = require './application-manager'

validateLocalState = (state) ->
	if state.name?
		throw new Error('Invalid device name') if not validation.isValidShortText(state.name)
	if !state.apps? or !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid apps')
	if !state.config? or !validation.isValidEnv(state.config)
		throw new Error('Invalid device configuration')

validateDependentState = (state) ->
	if state.apps? and !validation.isValidDependentAppsObject(state.apps)
		throw new Error('Invalid dependent apps')
	if state.devices? and !validation.isValidDependentDevicesObject(state.devices)
		throw new Error('Invalid dependent devices')

validateState = Promise.method (state) ->
	if !_.isObject(state)
		throw new Error('State must be an object')
	if !_.isObject(state.local)
		throw new Error('Local state must be an object')
	validateLocalState(state.local)
	if state.dependent?
		validateDependentState(state.dependent)

# TODO (refactor): This shouldn't be here, and instead should be part of the other
# device api stuff in ./device-api
createDeviceStateRouter = (deviceState) ->
	router = express.Router()
	router.use(bodyParser.urlencoded(extended: true))
	router.use(bodyParser.json())

	rebootOrShutdown = (req, res, action) ->
		deviceState.config.get('lockOverride')
		.then (lockOverride) ->
			force = validation.checkTruthy(req.body.force) or lockOverride
			deviceState.executeStepAction({ action }, { force })
		.then (response) ->
			res.status(202).json(response)
		.catch (err) ->
			if err instanceof UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.post '/v1/reboot', (req, res) ->
		rebootOrShutdown(req, res, 'reboot')

	router.post '/v1/shutdown', (req, res) ->
		rebootOrShutdown(req, res, 'shutdown')

	router.get '/v1/device/host-config', (req, res) ->
		hostConfig.get()
		.then (conf) ->
			res.json(conf)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.patch '/v1/device/host-config', (req, res) ->
		hostConfig.patch(req.body, deviceState.config)
		.then ->
			res.status(200).send('OK')
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.get '/v1/device', (req, res) ->
		deviceState.getStatus()
		.then (state) ->
			stateToSend = _.pick(state.local, [
				'api_port'
				'ip_address'
				'os_version'
				'supervisor_version'
				'update_pending'
				'update_failed'
				'update_downloaded'
			])
			if state.local.is_on__commit?
				stateToSend.commit = state.local.is_on__commit
			# Will produce nonsensical results for multicontainer apps...
			service = _.toPairs(_.toPairs(state.local.apps)[0]?[1]?.services)[0]?[1]
			if service?
				stateToSend.status = service.status
				# For backwards compatibility, we adapt Running to the old "Idle"
				if stateToSend.status == 'Running'
					stateToSend.status = 'Idle'
				stateToSend.download_progress = service.download_progress
			res.json(stateToSend)
		.catch (err) ->
			res.status(500).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.use(deviceState.applications.router)
	return router

module.exports = class DeviceState extends EventEmitter
	constructor: ({ @db, @config, @eventTracker, @logger }) ->
		@deviceConfig = new DeviceConfig({ @db, @config, @logger })
		@applications = new ApplicationManager({ @config, @logger, @db, @eventTracker, deviceState: this })
		@on 'error', (err) ->
			console.error('Error in deviceState: ', err, err.stack)
		@_currentVolatile = {}
		@_writeLock = updateLock.writeLock
		@_readLock = updateLock.readLock
		@lastSuccessfulUpdate = null
		@failedUpdates = 0
		@applyInProgress = false
		@lastApplyStart = process.hrtime()
		@scheduledApply = null
		@shuttingDown = false
		@router = createDeviceStateRouter(this)
		@on 'apply-target-state-end', (err) ->
			if err?
				console.log("Apply error #{err}")
			else
				console.log('Apply success!')
		@applications.on('change', @reportCurrentState)

	healthcheck: =>
		@config.getMany([ 'unmanaged' ])
		.then (conf) =>
			cycleTime = process.hrtime(@lastApplyStart)
			cycleTimeMs = cycleTime[0] * 1000 + cycleTime[1] / 1e6
			cycleTimeWithinInterval = cycleTimeMs - @applications.timeSpentFetching < 2 * @maxPollTime
			applyTargetHealthy = conf.unmanaged or !@applyInProgress or @applications.fetchesInProgress > 0 or cycleTimeWithinInterval
			return applyTargetHealthy

	migrateLegacyApps: (balenaApi) =>
		console.log('Migrating ids for legacy app...')
		@db.models('app').select()
		.then (apps) =>
			if apps.length == 0
				console.log('No app to migrate')
				return
			app = apps[0]
			services = JSON.parse(app.services)
			# Check there's a main service, with legacy-container set
			if services.length != 1
				console.log("App doesn't have a single service, ignoring")
				return
			service = services[0]
			if !service.labels['io.resin.legacy-container'] and !service.labels['io.balena.legacy-container']
				console.log('Service is not marked as legacy, ignoring')
				return
			console.log("Getting release #{app.commit} for app #{app.appId} from API")
			balenaApi.get(
				resource: 'release'
				options:
					$filter:
						belongs_to__application: app.appId
						commit: app.commit
						status: 'success'
					$expand:
						contains__image: [ 'image' ]
			)
			.then (releasesFromAPI) =>
				if releasesFromAPI.length == 0
					throw new Error('No compatible releases found in API')
				release = releasesFromAPI[0]
				releaseId = release.id
				image = release.contains__image[0].image[0]
				imageId = image.id
				serviceId = image.is_a_build_of__service.__id
				imageUrl = image.is_stored_at__image_location
				if image.content_hash
					imageUrl += "@#{image.content_hash}"
				console.log("Found a release with releaseId #{releaseId}, imageId #{imageId}, serviceId #{serviceId}")
				console.log("Image location is #{imageUrl}")
				Promise.join(
					@applications.docker.getImage(service.image).inspect().catchReturn(NotFoundError, null)
					@db.models('image').where(name: service.image).select()
					(imageFromDocker, imagesFromDB) =>
						@db.transaction (trx) ->
							Promise.try ->
								if imagesFromDB.length > 0
									console.log('Deleting existing image entry in db')
									trx('image').where(name: service.image).del()
								else
									console.log('No image in db to delete')
							.then ->
								if imageFromDocker?
									console.log('Inserting fixed image entry in db')
									newImage = {
										name: imageUrl,
										appId: app.appId,
										serviceId: serviceId,
										serviceName: service.serviceName,
										imageId: imageId,
										releaseId: releaseId,
										dependent: 0
										dockerImageId: imageFromDocker.Id
									}
									trx('image').insert(newImage)
								else
									console.log('Image is not downloaded, so not saving it to db')
							.then ->
								service.image = imageUrl
								service.serviceID = serviceId
								service.imageId = imageId
								service.releaseId = releaseId
								delete service.labels['io.resin.legacy-container']
								delete service.labels['io.balena.legacy-container']
								app.services = JSON.stringify([ service ])
								app.releaseId = releaseId
								console.log('Updating app entry in db')
								trx('app').update(app).where({ appId: app.appId })
				)

	normaliseLegacy: (balenaApi) =>
		# When legacy apps are present, we kill their containers and migrate their /data to a named volume
		# We also need to get the releaseId, serviceId, imageId and updated image URL
		@migrateLegacyApps(balenaApi)
		.then =>
			console.log('Killing legacy containers')
			@applications.services.killAllLegacy()
		.then =>
			console.log('Migrating legacy app volumes')
			@applications.getTargetApps()
			.then(_.keys)
		.map (appId) =>
			@applications.volumes.createFromLegacy(appId)
		.then =>
			@config.set({ legacyAppsPresent: 'false' })

	init: ->
		@config.on 'change', (changedConfig) =>
			if changedConfig.loggingEnabled?
				@logger.enable(changedConfig.loggingEnabled)
			if changedConfig.apiSecret?
				@reportCurrentState(api_secret: changedConfig.apiSecret)
			if changedConfig.appUpdatePollInterval?
				@maxPollTime = changedConfig.appUpdatePollInterval

		@config.getMany([
			'initialConfigSaved', 'listenPort', 'apiSecret', 'osVersion', 'osVariant',
			'version', 'provisioned', 'apiEndpoint', 'connectivityCheckEnabled', 'legacyAppsPresent',
			'targetStateSet', 'unmanaged', 'appUpdatePollInterval'
		])
		.then (conf) =>
			@maxPollTime = conf.appUpdatePollInterval
			@applications.init()
			.then =>
				if !conf.initialConfigSaved
					@saveInitialConfig()
			.then =>
				@initNetworkChecks(conf)
				console.log('Reporting initial state, supervisor version and API info')
				@reportCurrentState(
					api_port: conf.listenPort
					api_secret: conf.apiSecret
					os_version: conf.osVersion
					os_variant: conf.osVariant
					supervisor_version: conf.version
					provisioning_progress: null
					provisioning_state: ''
					status: 'Idle'
					logs_channel: null
					update_failed: false
					update_pending: false
					update_downloaded: false
				)
			.then =>
				@applications.getTargetApps()
			.then (targetApps) =>
				if !conf.provisioned or (_.isEmpty(targetApps) and !conf.targetStateSet)
					@loadTargetFromFile()
					.finally =>
						@config.set({ targetStateSet: 'true' })
				else
					console.log('Skipping preloading')
					if conf.provisioned and !_.isEmpty(targetApps)
						# If we're in this case, it's because we've updated from an older supervisor
						# and we need to mark that the target state has been set so that
						# the supervisor doesn't try to preload again if in the future target
						# apps are empty again (which may happen with multi-app).
						@config.set({ targetStateSet: 'true' })
			.then =>
				@triggerApplyTarget({ initial: true })

	initNetworkChecks: ({ apiEndpoint, connectivityCheckEnabled, unmanaged }) =>
		return if unmanaged
		network.startConnectivityCheck apiEndpoint, connectivityCheckEnabled, (connected) =>
			@connected = connected
		@config.on 'change', (changedConfig) ->
			if changedConfig.connectivityCheckEnabled?
				network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled)
		console.log('Starting periodic check for IP addresses')
		network.startIPAddressUpdate() (addresses) =>
			@reportCurrentState(
				ip_address: addresses.join(' ')
			)
		, constants.ipAddressUpdateInterval

	saveInitialConfig: =>
		@deviceConfig.getCurrent()
		.then (devConf) =>
			@deviceConfig.setTarget(devConf)
		.then =>
			@config.set({ initialConfigSaved: 'true' })

	emitAsync: (ev, args...) =>
		setImmediate => @emit(ev, args...)

	_readLockTarget: =>
		@_readLock('target').disposer (release) ->
			release()
	_writeLockTarget: =>
		@_writeLock('target').disposer (release) ->
			release()
	_inferStepsLock: =>
		@_writeLock('inferSteps').disposer (release) ->
			release()

	usingReadLockTarget: (fn) =>
		Promise.using @_readLockTarget, -> fn()
	usingWriteLockTarget: (fn) =>
		Promise.using @_writeLockTarget, -> fn()
	usingInferStepsLock: (fn) =>
		Promise.using @_inferStepsLock, -> fn()

	setTarget: (target, localSource = false) ->
		Promise.join(
			@config.get('apiEndpoint'),
			validateState(target),
			(apiEndpoint) =>
				@usingWriteLockTarget =>
					# Apps, deviceConfig, dependent
					@db.transaction (trx) =>
						Promise.try =>
							@config.set({ name: target.local.name }, trx)
						.then =>
							@deviceConfig.setTarget(target.local.config, trx)
						.then =>
							if localSource or not apiEndpoint
								@applications.setTarget(target.local.apps, target.dependent, 'local', trx)
							else
								@applications.setTarget(target.local.apps, target.dependent, apiEndpoint, trx)
		)

	getTarget: ({ initial = false, intermediate = false } = {}) =>
		@usingReadLockTarget =>
			if intermediate
				return @intermediateTarget
			Promise.props({
				local: Promise.props({
					name: @config.get('name')
					config: @deviceConfig.getTarget({ initial })
					apps: @applications.getTargetApps()
				})
				dependent: @applications.getDependentTargets()
			})

	getStatus: ->
		@applications.getStatus()
		.then (appsStatus) =>
			theState = { local: {}, dependent: {} }
			_.merge(theState.local, @_currentVolatile)
			theState.local.apps = appsStatus.local
			theState.dependent.apps = appsStatus.dependent
			if appsStatus.commit and !@applyInProgress
				theState.local.is_on__commit = appsStatus.commit
			return theState

	getCurrentForComparison: ->
		Promise.join(
			@config.get('name')
			@deviceConfig.getCurrent()
			@applications.getCurrentForComparison()
			@applications.getDependentState()
			(name, devConfig, apps, dependent) ->
				return {
					local: {
						name
						config: devConfig
						apps
					}
					dependent
				}
		)

	reportCurrentState: (newState = {}) =>
		_.assign(@_currentVolatile, newState)
		@emitAsync('change')

	_convertLegacyAppsJson: (appsArray) ->
		Promise.try ->
			deviceConf = _.reduce(appsArray, (conf, app) ->
				return _.merge({}, conf, app.config)
			, {})
			apps = _.keyBy(_.map(appsArray, singleToMulticontainerApp), 'appId')
			return { apps, config: deviceConf }

	restoreBackup: (targetState) =>
		@setTarget(targetState)
		.then =>
			appId = _.keys(targetState.local.apps)[0]
			if !appId?
				throw new Error('No appId in target state')
			volumes = targetState.local.apps[appId].volumes
			backupPath = path.join(constants.rootMountPoint, 'mnt/data/backup')
			rimraf(backupPath) # We clear this path in case it exists from an incomplete run of this function
			.then ->
				mkdirp(backupPath)
			.then ->
				execAsync("tar -xzf backup.tgz -C #{backupPath} .", cwd: path.join(constants.rootMountPoint, 'mnt/data'))
			.then ->
				fs.readdirAsync(backupPath)
			.then (dirContents) =>
				Promise.mapSeries dirContents, (volumeName) =>
					fs.statAsync(path.join(backupPath, volumeName))
					.then (s) =>
						if !s.isDirectory()
							throw new Error("Invalid backup: #{volumeName} is not a directory")
						if volumes[volumeName]?
							console.log("Creating volume #{volumeName} from backup")
							# If the volume exists (from a previous incomplete run of this restoreBackup), we delete it first
							@applications.volumes.get({ appId, name: volumeName })
							.then =>
								@applications.volumes.remove({ appId, name: volumeName })
							.catch(NotFoundError, _.noop)
							.then =>
								@applications.volumes.createFromPath({ appId, name: volumeName, config: volumes[volumeName] }, path.join(backupPath, volumeName))
						else
							throw new Error("Invalid backup: #{volumeName} is present in backup but not in target state")
			.then ->
				rimraf(backupPath)
			.then ->
				rimraf(path.join(constants.rootMountPoint, 'mnt/data', constants.migrationBackupFile))

	loadTargetFromFile: (appsPath) ->
		console.log('Attempting to load preloaded apps...')
		appsPath ?= constants.appsJsonPath
		fs.readFileAsync(appsPath, 'utf8')
		.then(JSON.parse)
		.then (stateFromFile) =>
			if _.isArray(stateFromFile)
				# This is a legacy apps.json
				console.log('Legacy apps.json detected')
				return @_convertLegacyAppsJson(stateFromFile)
			else
				return stateFromFile
		.then (stateFromFile) =>
			commitToPin = null
			appToPin = null
			if !_.isEmpty(stateFromFile)
				images = _.flatMap stateFromFile.apps, (app, appId) =>
					# multi-app warning!
					# The following will need to be changed once running multiple applications is possible
					commitToPin = app.commit
					appToPin = appId
					_.map app.services, (service, serviceId) =>
						svc = {
							imageName: service.image
							serviceName: service.serviceName
							imageId: service.imageId
							serviceId
							releaseId: app.releaseId
							appId
						}
						return @applications.imageForService(svc)
				Promise.map images, (img) =>
					@applications.images.normalise(img.name)
					.then (name) =>
						img.name = name
						@applications.images.save(img)
				.then =>
					@deviceConfig.getCurrent()
				.then (deviceConf) =>
					@deviceConfig.formatConfigKeys(stateFromFile.config)
					.then (formattedConf) =>
						stateFromFile.config = _.defaults(formattedConf, deviceConf)
						stateFromFile.name ?= ''
						@setTarget({
							local: stateFromFile
						})
				.then =>
					console.log('Preloading complete')
					if stateFromFile.pinDevice
						# multi-app warning!
						# The following will need to be changed once running multiple applications is possible
						console.log('Device will be pinned')
						if commitToPin? and appToPin?
							@config.set
								pinDevice: {
									commit: commitToPin,
									app: parseInt(appToPin, 10),
								}
		# Ensure that this is actually a file, and not an empty path
		# It can be an empty path because if the file does not exist
		# on host, the docker daemon creates an empty directory when
		# the bind mount is added
		.catch ENOENT, EISDIR, ->
			console.log('No apps.json file present, skipping preload')
		.catch (err) =>
			@eventTracker.track('Loading preloaded apps failed', { error: err })

	reboot: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Rebooting', {}, 'Reboot')
			systemd.reboot()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	shutdown: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Shutting down', {}, 'Shutdown')
			systemd.shutdown()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	executeStepAction: (step, { force, initial, skipLock }) =>
		Promise.try =>
			if @deviceConfig.isValidAction(step.action)
				@deviceConfig.executeStepAction(step, { initial })
			else if _.includes(@applications.validActions, step.action)
				@applications.executeStepAction(step, { force, skipLock })
			else
				switch step.action
					when 'reboot'
						# There isn't really a way that these methods can fail,
						# and if they do, we wouldn't know about it until after
						# the response has been sent back to the API. Just return
						# "OK" for this and the below action
						@reboot(force, skipLock).return(Data: 'OK', Error: null)
					when 'shutdown'
						@shutdown(force, skipLock).return(Data: 'OK', Error: null)
					when 'noop'
						Promise.resolve()
					else
						throw new Error("Invalid action #{step.action}")

	applyStep: (step, { force, initial, intermediate, skipLock }) =>
		if @shuttingDown
			return
		@executeStepAction(step, { force, initial, skipLock })
		.tapCatch (err) =>
			@emitAsync('step-error', err, step)
		.then (stepResult) =>
			@emitAsync('step-completed', null, step, stepResult)

	applyError: (err, { force, initial, intermediate }) =>
		@emitAsync('apply-target-state-error', err)
		@emitAsync('apply-target-state-end', err)
		if intermediate
			throw err
		@failedUpdates += 1
		@reportCurrentState(update_failed: true)
		if @scheduledApply?
			console.log("Updating failed, but there's another update scheduled immediately: ", err)
		else
			delay = Math.min((2 ** @failedUpdates) * constants.backoffIncrement, @maxPollTime)
			# If there was an error then schedule another attempt briefly in the future.
			console.log('Scheduling another update attempt due to failure: ', delay, err)
			@triggerApplyTarget({ force, delay, initial })

	applyTarget: ({ force = false, initial = false, intermediate = false, skipLock = false } = {}) =>
		nextDelay = 200
		Promise.try =>
			if !intermediate
				@applyBlocker
		.then =>
			@usingInferStepsLock =>
				@applications.getExtraStateForComparison()
				.then (extraState) =>
					Promise.all([
						@getCurrentForComparison()
						@getTarget({ initial, intermediate })
					])
					.then ([ currentState, targetState ]) =>
						@deviceConfig.getRequiredSteps(currentState, targetState)
						.then (deviceConfigSteps) =>
							if !_.isEmpty(deviceConfigSteps)
								return deviceConfigSteps
							else
								@applications.getRequiredSteps(currentState, targetState, extraState, intermediate)
		.then (steps) =>
			if _.isEmpty(steps)
				@emitAsync('apply-target-state-end', null)
				if !intermediate
					console.log('Finished applying target state')
					@applications.timeSpentFetching = 0
					@failedUpdates = 0
					@lastSuccessfulUpdate = Date.now()
					@reportCurrentState(update_failed: false, update_pending: false, update_downloaded: false)
				return
			if !intermediate
				@reportCurrentState(update_pending: true)
			if _.every(steps, (step) -> step.action == 'noop')
				nextDelay = 1000
			Promise.map steps, (step) =>
				@applyStep(step, { force, initial, intermediate, skipLock })
			.delay(nextDelay)
			.then =>
				@applyTarget({ force, initial, intermediate, skipLock })
		.catch (err) =>
			@applyError(err, { force, initial, intermediate })

	pausingApply: (fn) =>
		lock = =>
			@_writeLock('pause').disposer (release) ->
				release()
		pause = =>
			Promise.try =>
				res = null
				@applyBlocker = new Promise (resolve) ->
					res = resolve
				return res
			.disposer (resolve) ->
				resolve()

		Promise.using lock(), ->
			Promise.using pause(), ->
				fn()

	resumeNextApply: =>
		@applyUnblocker?()
		return

	triggerApplyTarget: ({ force = false, delay = 0, initial = false } = {}) =>
		if @applyInProgress
			if !@scheduledApply?
				@scheduledApply = { force, delay }
			else
				# If a delay has been set it's because we need to hold off before applying again,
				# so we need to respect the maximum delay that has been passed
				@scheduledApply.delay = Math.max(delay, @scheduledApply.delay)
				@scheduledApply.force or= force
			return
		@applyInProgress = true
		Promise.delay(delay)
		.then =>
			@lastApplyStart = process.hrtime()
			console.log('Applying target state')
			@applyTarget({ force, initial })
		.finally =>
			@applyInProgress = false
			@reportCurrentState()
			if @scheduledApply?
				@triggerApplyTarget(@scheduledApply)
				@scheduledApply = null
		return null

	applyIntermediateTarget: (intermediateTarget, { force = false, skipLock = false } = {}) =>
		@intermediateTarget = _.cloneDeep(intermediateTarget)
		@applyTarget({ intermediate: true, force, skipLock })
		.then =>
			@intermediateTarget = null
