Promise = require 'bluebird'
_ = require 'lodash'
express = require 'express'
bodyParser = require 'body-parser'

constants = require './lib/constants'
DEFAULT_DELTA_APPLY_TIMEOUT = 300 * 1000 # 6 minutes

process.env.DOCKER_HOST ?= "unix://#{constants.dockerSocket}"
Docker = require './lib/docker-utils'
updateLock = require './lib/update-lock'
{ checkTruthy, checkInt, checkString } = require './lib/validation'

ServiceManager = require './compose/service-manager'
Service = require './compose/service'
Images = require './compose/images'
Networks = require './compose/networks'
Volumes = require './compose/volumes'

Proxyvisor = require './proxyvisor'

# TODO: implement v2 endpoints
# v1 endpoins only work for single-container apps as they assume the app has a single service.
class ApplicationManagerRouter
	constructor: (@applications) ->
		{ @proxyvisor, @eventTracker } = @applications
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())

		@router.post '/v1/restart', (req, res) =>
			appId = checkString(req.body.appId)
			force = checkTruthy(req.body.force)
			@eventTracker.track('Restart container (v1)', { appId })
			if !appId?
				return res.status(400).send('Missing app id')
			@applications.getCurrentApp(appId)
			.then (app) =>
				service = app?.services?[0]
				return res.status(400).send('App not found') if !service?
				return res.status(400).send('v1 endpoints are only allowed on single-container apps') if app.services.length > 1
				@applications.executeStepAction({
					action: 'restart'
					current: service
					target: service
					serviceId: service.serviceId
				}, { force })
				.then ->
					res.status(200).send('OK')
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/v1/apps/:appId/stop', (req, res) =>
			appId = checkString(req.params.appId)
			force = checkTruthy(req.body.force)
			if !appId?
				return res.status(400).send('Missing app id')
			@applications.getCurrentApp(appId)
			.then (app) =>
				service = app?.services?[0]
				return res.status(400).send('App not found') if !service?
				return res.status(400).send('v1 endpoints are only allowed on single-container apps') if app.services.length > 1
				@applications.setTargetVolatileForService(service.serviceId, running: false)
				@applications.executeStepAction({
					action: 'stop'
					current: service
					serviceId: service.serviceId
				}, { force })
			.then (service) ->
				res.status(200).json({ containerId: service.containerId })
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/v1/apps/:appId/start', (req, res) =>
			appId = checkString(req.params.appId)
			force = checkTruthy(req.body.force)
			if !appId?
				return res.status(400).send('Missing app id')
			@applications.getCurrentApp(appId)
			.then (app) =>
				service = app?.services?[0]
				return res.status(400).send('App not found') if !service?
				return res.status(400).send('v1 endpoints are only allowed on single-container apps') if app.services.length > 1
				@applications.setTargetVolatileForService(service.serviceId, running: true)
				@applications.executeStepAction({
					action: 'start'
					target: service
					serviceId: service.serviceId
				}, { force })
			.then (service) ->
				res.status(200).json({ containerId: service.containerId })
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.get '/v1/apps/:appId', (req, res) =>
			appId = checkString(req.params.appId)
			@eventTracker.track('GET app (v1)', appId)
			if !appId?
				return res.status(400).send('Missing app id')
			@applications.getCurrentApp(appId)
			.then (app) ->
				service = app?.services?[0]
				return res.status(400).send('App not found') if !service?
				return res.status(400).send('v1 endpoints are only allowed on single-container apps') if app.services.length > 1
				# Don't return data that will be of no use to the user
				appToSend = {
					appId
					containerId: service.containerId
					env: _.omit(service.environment, constants.privateAppEnvVars)
					commit: app.commit
					releaseId: app.releaseId
					imageId: service.image
				}
				res.json(appToSend)
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')

		@router.post '/v1/purge', (req, res) =>
			appId = checkString(req.body.appId)
			force = checkTruthy(req.body.force)
			if !appId?
				errMsg = "App not found: an app needs to be installed for purge to work.
						If you've recently moved this device from another app,
						please push an app and wait for it to be installed first."
				return res.status(400).send(errMsg)
			Promise.using updateLock.lock(appId, { force }), =>
				@applications.getCurrentApp(appId)
				.then (app) =>
					service = app?.services?[0]
					return res.status(400).send('App not found') if !service?
					return res.status(400).send('v1 endpoints are only allowed on single-container apps') if app.services.length > 1
					@applications.executeStepAction({
						action: 'kill'
						serviceId: service.serviceId
						current: service
						options:
							skipLock: true
					}, { force })
					.then =>
						@applications.executeStepAction({
							action: 'purge'
							appId: app.appId
							options:
								skipLock: true
						}, { force })
					.then =>
						@applications.executeStepAction({
							action: 'start'
							serviceId: service.serviceId
							target: service
							options:
								skipLock: true
						}, { force })
					.then ->
						res.status(200).json(Data: 'OK', Error: '')
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')
		@router.use(@proxyvisor.router)

module.exports = class ApplicationManager
	constructor: ({ @logger, @config, @reportCurrentState, @db, @eventTracker }) ->
		@docker = new Docker()
		@images = new Images({ @docker, @logger, @db, @reportServiceStatus })
		@services = new ServiceManager({ @docker, @logger, @images, @config, @reportServiceStatus })
		@networks = new Networks({ @docker, @logger })
		@volumes = new Volumes({ @docker, @logger })
		@proxyvisor = new Proxyvisor({ @config, @logger, @db, @docker, @images, @reportCurrentState, applications: this })
		@volatileState = {}
		@_targetVolatilePerServiceId = {}
		@validActions = [
			'kill'
			'start'
			'stop'
			'fetch'
			'removeImage'
			'killAll'
			'purge'
			'restart'
			'cleanup'
			'createNetworkOrVolume'
			'removeNetworkOrVolume'
		].concat(@proxyvisor.validActions)
		@_router = new ApplicationManagerRouter(this)
		@globalAppStatus = {
			status: 'Idle'
			download_progress: null
		}
		@downloadsInProgress = 0
		@router = @_router.router

	reportServiceStatus: (serviceId, updatedStatus) =>
		if @downloadsInProgress > 0 and updatedStatus.download_progress?
			@globalAppStatus.download_progress = updatedStatus.download_progress / @downloadsInProgress
		if serviceId?
			@volatileState[serviceId] ?= {}
			_.assign(@volatileState[serviceId], updatedStatus)
		@reportCurrentState(@globalAppStatus)

	init: =>
		@services.attachToRunning()
		.then =>
			@services.listenToEvents()

	# Returns the status of applications and their services
	getStatus: =>
		@services.getAll()
		.then (services) =>
			apps = _.keyBy(_.map(_.uniq(_.map(services, 'appId')), (appId) -> { appId }), 'appId')
			oldestContainer = {}
			# We iterate over the current running services and add them to the current state
			# of the app they belong to.
			_.forEach services, (service) =>
				appId = service.appId
				apps[appId].services ?= []
				# We use the oldest container in an app to define the current releaseId and commit
				if !apps[appId].releaseId? or service.createdAt < oldestContainer[appId]
					apps[appId].releaseId = service.releaseId
					apps[appId].commit = service.commit
					oldestContainer[appId] = service.createdAt

				service = _.pick(service, [ 'serviceId', 'imageId', 'status' ])
				# If there's volatile state relating to this service, we're either downloading
				# or installing it
				if @volatileState[service.serviceId]
					service.status = @volatileState[service.serviceId]
				apps[appId].services.push(service)

			# There may be services that are being installed or downloaded which still
			# don't have a running container, so we make them part of the reported current state
			_.forEach @volatileState, (serviceState) ->
				appId = serviceState.appId
				apps[appId] ?= { appId }
				apps[appId].releaseId ?= null
				apps[appId].services ?= []
				service = _.pick(serviceState, [ 'status', 'serviceId' ])
				service.imageId = null
				apps[appId].services.push(service)

			# We return an array of the apps, not an object
			return _.values(apps)

	getDependentState: =>
		@proxyvisor.getCurrentStates()

	_buildApps: (services, networks, volumes) ->
		apps = _.keyBy(_.map(_.uniq(_.map(services, 'appId')), (appId) -> { appId }), 'appId')

		# We iterate over the current running services and add them to the current state
		# of the app they belong to.
		_.forEach services, (service) ->
			appId = service.appId
			apps[appId].services ?= []
			apps[appId].services.push(service)

		_.forEach networks, (network) ->
			appId = network.appId
			apps[appId] ?= { appId }
			apps[appId].networks ?= {}
			apps[appId].networks[network.name] = network.config

		_.forEach volumes, (volume) ->
			appId = volume.appId
			apps[appId] ?= { appId }
			apps[appId].volumes ?= {}
			apps[appId].volumes[volume.name] = volume.config

		# We return the apps as an array
		return _.values(apps)

	getCurrentForComparison: =>
		Promise.join(
			@services.getAll()
			@networks.getAll()
			@volumes.getAll()
			(services, networks, volumes) =>
				# We return the apps as an array
				return @_buildApps(services, networks, volumes)
		)

	getCurrentApp: (appId) =>
		Promise.join(
			@services.getAllByAppId(appId)
			@networks.getAllByAppId(appId)
			@volumes.getAllByAppId(appId)
			(services, networks, volumes) =>
				# We return the apps as an array
				return @_buildApps(services, networks, volumes)[0]
		)

	getTargetApp: (appId) =>
		@db.models('app').where({ appId }).select()
		.then ([ app ]) =>
			return if !app?
			@normaliseAndExtendAppFromDB(app)

	# Compares current and target services and returns a list of service pairs to be updated/removed/installed.
	# The returned list is an array of objects where the "current" and "target" properties define the update pair, and either can be null
	# (in the case of an install or removal).
	compareServicesForUpdate: (currentServices, targetServices) ->
		Promise.try ->
			removePairs = []
			installPairs = []
			updatePairs = []
			targetServiceIds = _.map(targetServices, 'serviceId')
			currentServiceIds = _.uniq(_.map(currentServices, 'serviceId'))

			toBeRemoved = _.difference(currentServiceIds, targetServiceIds)
			_.forEach toBeRemoved, (serviceId) ->
				servicesToRemove = _.filter(currentServices, (s) -> s.serviceId == serviceId)
				_.map servicesToRemove, (service) ->
					removePairs.push({
						current: service
						target: null
						serviceId
					})

			toBeInstalled = _.difference(targetServiceIds, currentServiceIds)
			_.forEach toBeInstalled, (serviceId) ->
				servicesToInstall = _.filter(targetServices, (s) -> s.serviceId == serviceId)
				_.map servicesToInstall, (service) ->
					installPairs.push({
						current: null
						target: service
						serviceId
					})

			toBeMaybeUpdated = _.intersection(targetServiceIds, currentServiceIds)
			currentServicesPerId = {}
			targetServicesPerId = {}
			_.forEach toBeMaybeUpdated, (serviceId) ->
				currentServiceContainers = _.filter currentServices, (service) ->
					return service.serviceId == serviceId
				targetServicesForId = _.filter targetServices, (service) ->
					return service.serviceId == serviceId
				throw new Error("Target state includes multiple services with serviceId #{serviceId}") if targetServicesForId.length > 1
				targetServicesPerId[serviceId] = targetServicesForId[0]
				if currentServiceContainers.length > 1
					currentServicesPerId[serviceId] = _.maxBy(currentServiceContainers, 'createdAt')
					# All but the latest container for this service are spurious and should be removed
					_.forEach _.without(currentServiceContainers, currentServicesPerId[serviceId]), (service) ->
						removePairs.push({
							current: service
							target: null
							serviceId
							isSpurious: true
						})
				else
					currentServicesPerId[serviceId] = currentServiceContainers[0]

			Promise.filter toBeMaybeUpdated, (serviceId) ->
				return !currentServicesPerId[serviceId].isEqual(targetServicesPerId[serviceId])
			.map (serviceId) ->
				onlyStartOrStop = currentServicesPerId[serviceId].isSameContainer(targetServicesPerId[serviceId])
				updatePairs.push({
					current: currentServicesPerId[serviceId]
					target: targetServicesPerId[serviceId]
					isRunningStateChange: onlyStartOrStop
				})
			.then ->
				return { removePairs, installPairs, updatePairs }

	compareNetworksOrVolumesForUpdate: (model, { current, target }, appId) ->
		Promise.try ->
			outputPairs = []
			currentNames = _.keys(current)
			targetNames = _.keys(target)
			toBeRemoved = _.difference(currentNames, targetNames)
			_.forEach toBeRemoved, (name) ->
				outputPairs.push({
					current: {
						name
						appId
						config: current[name]
					}
					target: null
				})
			toBeInstalled = _.difference(targetNames, currentNames)
			_.forEach toBeInstalled, (name) ->
				outputPairs.push({
					current: null
					target: {
						name
						appId
						config: target[name]
					}
				})
			toBeUpdated = _.filter _.intersection(targetNames, currentNames), (name) ->
				!model.isEqualConfig(current[name], target[name])
			_.forEach toBeUpdated, (name) ->
				outputPairs.push({
					current: {
						name
						appId
						config: current[name]
					}
					target: {
						name
						appId
						config: target[name]
					}
				})
			return outputPairs

	hasCurrentNetworksOrVolumes: (service, networkPairs, volumePairs) ->
		hasNetwork = _.some networkPairs, (pair) ->
			pair.current.name == service.network_mode
		return true if hasNetwork
		hasVolume = _.some service.volumes, (volume) ->
			name = _.split(volume, ':')[0]
			_.some volumePairs, (pair) ->
				pair.current.name == name
		return true if hasVolume
		return false

	# TODO: account for volumes-from, networks-from, links, etc
	# TODO: support networks instead of only network_mode
	_dependenciesMetForServiceStart: (target, networkPairs, volumePairs, pendingPairs, stepsInProgress) ->
		# for depends_on, check no install or update pairs have that service
		dependencyUnmet = _.some target.depends_on ? [], (dependency) ->
			_.find(pendingPairs, (pair) -> pair.target?.serviceName == dependency)? or _.find(stepsInProgress, (step) -> step.target?.serviceName == dependency)?
		return false if dependencyUnmet
		# for networks and volumes, check no network pairs have that volume name
		if _.find(networkPairs, (pair) -> pair.target.name == target.network_mode)?
			return false
		if _.find(stepsInProgress, (step) -> step.model == 'network' and step.target.name == target.network_mode)?
			return false
		volumeUnmet = _.some target.volumes, (volumeDefinition) ->
			sourceName = volumeDefinition.split(':')[0]
			_.find(volumePairs, (pair) -> pair.target.name == sourceName)? or _.find(stepsInProgress, (step) -> step.model == 'volume' and step.target.name == sourceName)?
		return !volumeUnmet

	_nextStepsForNetworkOrVolume: ({ current, target }, currentApp, changingPairs, dependencyComparisonFn, force, model) ->
		# Check none of the currentApp.services use this network or volume
		if current?
			dependencies = _.filter currentApp.services, (service) ->
				dependencyComparisonFn(service, current)
			if _.isEmpty(dependencies)
				return [{
					action: 'removeNetworkOrVolume'
					model
					current
				}]
			else
				# If the current update doesn't require killing the services that use this network/volume,
				# we have to kill them before removing the network/volume (e.g. when we're only updating the network config)
				steps = []
				_.forEach dependencies, (dependency) ->
					if !_.some(changingPairs, (pair) -> pair.serviceId == dependency.serviceId)
						steps.push({
							action: 'kill'
							serviceId: dependency.serviceId
							current: dependency
							options:
								force: Boolean(force)
						})
				return steps
		else if target?
			return [
				{
					action: 'createNetworkOrVolume'
					model
					target
				}
			]

	_nextStepsForNetwork: ({ current, target }, currentApp, changingPairs, force) =>
		dependencyComparisonFn = (service, current) ->
			service.network_mode == current.name
		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, force, 'network')

	_nextStepsForVolume: ({ current, target }, currentApp, changingPairs, force) ->
		# Check none of the currentApp.services use this network or volume
		dependencyComparisonFn = (service, current) ->
			_.some service.volumes, (volumeDefinition) ->
				sourceName = volumeDefinition.split(':')[0]
				sourceName == current.name
		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, force, 'volume')

	_stopOrStartStep: (current, target, force) ->
		if target.running
			return {
				action: 'start'
				serviceId: target.serviceId
				current
				target
			}
		else
			return {
				action: 'stop'
				serviceId: target.serviceId
				current
				target
				options:
					force: Boolean(force)
			}

	_fetchOrStartStep: (current, target, needsDownload, fetchOpts, dependenciesMetFn) ->
		if needsDownload
			return {
				action: 'fetch'
				serviceId: target.serviceId
				current
				target
				options: fetchOpts
			}
		else if dependenciesMetFn()
			return {
				action: 'start'
				serviceId: target.serviceId
				current
				target
			}
		else
			return null

	_strategySteps: {
		'download-then-kill': (current, target, force, needsDownload, fetchOpts, dependenciesMetFn) ->
			if needsDownload
				return {
					action: 'fetch'
					serviceId: target.serviceId
					current
					target
					options: fetchOpts
				}
			else if dependenciesMetFn()
				# We only kill when dependencies are already met, so that we minimize downtime
				return {
					action: 'kill'
					serviceId: target.serviceId
					current
					target
					options:
						force: Boolean(force)
				}
			else
				return null
		'kill-then-download': (current, target, force, needsDownload, fetchOpts, dependenciesMetFn) ->
			return {
				action: 'kill'
				serviceId: target.serviceId
				current
				target
				options:
					force: Boolean(force)
			}
		'delete-then-download': (current, target, force, needsDownload, fetchOpts, dependenciesMetFn) ->
			return {
				action: 'kill'
				serviceId: target.serviceId
				current
				target
				options:
					removeImage: true
					force: Boolean(force)
			}
		'hand-over': (current, target, force, needsDownload, fetchOpts, dependenciesMetFn, timeout) ->
			if needsDownload
				return {
					action: 'fetch'
					serviceId: target.serviceId
					current
					target
					options: fetchOpts
				}
			else if dependenciesMetFn()
				return {
					action: 'handover'
					serviceId: target.serviceId
					current
					target
					options:
						timeout: timeout
						force: Boolean(force)
				}
			else
				return null
	}

	_nextStepForService: ({ current, target, isRunningStateChange = false }, updateContext, fetchOpts) ->
		{ networkPairs, volumePairs, installPairs, updatePairs, targetApp, stepsInProgress, availableImages } = updateContext
		if _.find(stepsInProgress, (step) -> step.serviceId == target.serviceId)?
			# There is already a step in progress for this service, so we wait
			return null
		dependenciesMet = =>
			@_dependenciesMetForServiceStart(target, networkPairs, volumePairs, installPairs.concat(updatePairs), stepsInProgress)

		needsDownload = !_.some availableImages, (image) ->
			_.includes(image.NormalisedRepoTags, target.image)
		if isRunningStateChange
			# We're only stopping/starting it
			return @_stopOrStartStep(current, target, targetApp.config['RESIN_SUPERVISOR_OVERRIDE_LOCK'])
		else if !current?
			# Either this is a new service, or the current one has already been killed
			return @_fetchOrStartStep(current, target, needsDownload, fetchOpts, dependenciesMet)
		else
			strategy = checkString(target.labels['io.resin.update.strategy'])
			validStrategies = [ 'download-then-kill', 'kill-then-download', 'delete-then-download', 'hand-over' ]
			strategy = 'download-then-kill' if !_.includes(validStrategies, strategy)
			timeout = checkInt(target.labels['io.resin.update.handover_timeout'])
			return @_strategySteps[strategy](current, target, targetApp.config['RESIN_SUPERVISOR_OVERRIDE_LOCK'], needsDownload, fetchOpts, dependenciesMet, timeout)

	fetchOptionsFromAppConfig: (targetApp) ->
		return {
			delta: checkTruthy(targetApp.config['RESIN_SUPERVISOR_DELTA']) ? false
			deltaRequestTimeout: checkInt(targetApp.config['RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT'], positive: true)
			deltaApplyTimeout: checkInt(targetApp.config['RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT'], positive: true) ? DEFAULT_DELTA_APPLY_TIMEOUT
			deltaRetryCount: checkInt(targetApp.config['RESIN_SUPERVISOR_DELTA_RETRY_COUNT'], positive: true)
			deltaRetryInterval: checkInt(targetApp.config['RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL'], positive: true)
		}

	_nextStepsForAppUpdate: (currentApp, targetApp, availableImages = [], stepsInProgress = []) =>
		emptyApp = { services: [], volumes: {}, networks: {}, config: {} }
		if !targetApp?
			targetApp = emptyApp
		if !currentApp?
			currentApp = emptyApp
		appId = targetApp.appId ? currentApp.appId
		fetchOpts = @fetchOptionsFromAppConfig(targetApp)
		Promise.join(
			@compareNetworksOrVolumesForUpdate(@networks, { current: currentApp.networks, target: targetApp.networks }, appId)
			@compareNetworksOrVolumesForUpdate(@volumes, { current: currentApp.volumes, target: targetApp.volumes }, appId)
			@compareServicesForUpdate(currentApp.services, targetApp.services)
			(networkPairs, volumePairs, { removePairs, installPairs, updatePairs }) =>
				steps = []
				# All removePairs get a 'kill' action
				_.forEach removePairs, ({ current, isSpurious = false }) ->
					steps.push({
						action: 'kill'
						options:
							isRemoval: !isSpurious
							force: true
						current
						target: null
						serviceId: current.serviceId
					})
				# next step for install pairs in download - start order, but start requires dependencies, networks and volumes met
				# next step for update pairs in order by update strategy. start requires dependencies, networks and volumes met.
				_.forEach installPairs.concat(updatePairs), (pair) =>
					step = @_nextStepForService(pair, { networkPairs, volumePairs, installPairs, updatePairs, stepsInProgress, availableImages, targetApp }, fetchOpts)
					steps.push(step) if step?
				# next step for network pairs - remove requires services killed, create kill if no pairs or steps affect that service
				_.forEach networkPairs, (pair) =>
					pairSteps = @_nextStepsForNetwork(pair, currentApp, removePairs.concat(updatePairs), targetApp.config['RESIN_SUPERVISOR_OVERRIDE_LOCK'])
					steps = steps.concat(pairSteps) if !_.isEmpty(pairSteps)
				# next step for volume pairs - remove requires services killed, create kill if no pairs or steps affect that service
				_.forEach volumePairs, (pair) =>
					pairSteps = @_nextStepsForVolume(pair, currentApp, removePairs.concat(updatePairs), targetApp.config['RESIN_SUPERVISOR_OVERRIDE_LOCK'])
					steps = steps.concat(pairSteps) if !_.isEmpty(pairSteps)
				return steps
		)

	normaliseAppForDB: (app) =>
		Promise.map _.cloneDeep(app.services ? []), (service) =>
			service.appId = app.appId
			service.releaseId = app.releaseId
			service.image = @images.normalise(service.image)
			Promise.props(service)
		.then (services) ->
			dbApp = {
				appId: app.appId
				commit: app.commit
				name: app.name
				releaseId: app.releaseId
				config: JSON.stringify(app.config ? {})
				services: JSON.stringify(services)
				networks: JSON.stringify(app.networks ? {})
				volumes: JSON.stringify(app.volumes ? {})
			}
			return dbApp

	createTargetService: (service, opts) ->
		serviceOpts = {
			serviceName: service.serviceName
		}
		_.assign(serviceOpts, opts)
		@images.get(service.image)
		.catchReturn(undefined)
		.then (imageInfo) ->
			serviceOpts.imageInfo = imageInfo
			return new Service(service, serviceOpts)

	normaliseAndExtendAppFromDB: (app) =>
		Promise.join(
			@config.get('extendedEnvOptions')
			@docker.defaultBridgeGateway()
			(opts, supervisorApiHost) =>
				configOpts = {
					appName: app.name
					commit: app.commit
					supervisorApiHost
				}
				_.assign(configOpts, opts)
				volumes = JSON.parse(app.volumes)
				_.forEach volumes, (v) ->
					v.labels ?= {}
				Promise.map(JSON.parse(app.services), (service) => @createTargetService(service, configOpts))
				.then (services) ->
					# If a named volume is defined in a service, we add it app-wide so that we can track it and purge it
					_.forEach services, (s) ->
						serviceNamedVolumes = s.getNamedVolumes()
						_.forEach serviceNamedVolumes, (name) ->
							volumes[name] ?= { labels: {} }
					outApp = {
						appId: app.appId
						name: app.name
						commit: app.commit
						releaseId: app.releaseId
						config: JSON.parse(app.config)
						services: services
						networks: JSON.parse(app.networks)
						volumes: volumes
					}
					return outApp
		)

	setTarget: (apps, dependent , trx) =>
		setInTransaction = (trx) =>
			Promise.try =>
				if apps?
					Promise.map(apps, @normaliseAppForDB)
					.then (appsForDB) =>
						Promise.map appsForDB, (app) =>
							@db.upsertModel('app', app, { appId: app.appId }, trx)
						.then ->
							trx('app').whereNotIn('appId', _.map(appsForDB, 'appId')).del()
			.then =>
				@proxyvisor.setTargetInTransaction(dependent, trx)

		Promise.try =>
			if trx?
				setInTransaction(trx)
			else
				@db.transaction(setInTransaction)
		.then =>
			@_targetVolatilePerServiceId = {}

	setTargetVolatileForService: (serviceId, target) ->
		@_targetVolatilePerServiceId[serviceId] ?= {}
		_.assign(@_targetVolatilePerServiceId, target)

	getTargetApps: =>
		Promise.map(@db.models('app').select(), @normaliseAndExtendAppFromDB)
		.map (app) =>
			if !_.isEmpty(app.services)
				app.services = _.map app.services, (service) =>
					_.merge(service, @_targetVolatilePerServiceId[service.serviceId]) if @_targetVolatilePerServiceId[service.serviceId]
					return service
			return app

	getDependentTargets: =>
		@proxyvisor.getTarget()

	_allServiceAndAppIdPairs: (current, target) ->
		currentAppDirs = _.map current.local.apps, (app) ->
			_.map app.services, (service) ->
				return { appId: app.appId, serviceId: service.serviceId }
		targetAppDirs = _.map target.local.apps, (app) ->
			_.map app.services, (service) ->
				return { appId: app.appId, serviceId: service.serviceId }
		return _.union(_.flatten(currentAppDirs), _.flatten(targetAppDirs))

	_unnecessaryImages: (current, target, available) =>
		# return images that:
		# - are not used in the current state, and
		# - are not going to be used in the target state, and
		# - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
		allImagesForApp = (app) ->
			_.map app.services ? [], (service) ->
				service.image

		currentImages = _.flatten(_.map(current.local?.apps ? [], allImagesForApp))
		targetImages = _.flatten(_.map(target.local?.apps ? [], allImagesForApp))
		availableAndUnused = _.filter available, (image) ->
			!_.some currentImages.concat(targetImages), (imageInUse) ->
				_.includes(image.NormalisedRepoTags, imageInUse)
		imagesToDownload = _.filter targetImages, (imageName) ->
			!_.some available, (availableImage) ->
				_.includes(availableImage.NormalisedRepoTags, imageName)

		deltaSources = _.map imagesToDownload ? [], (imageName) =>
			return @docker.bestDeltaSource(imageName, available)

		proxyvisorImages = @proxyvisor.imagesInUse(current, target)

		return _.filter availableAndUnused, (image) ->
			notUsedForDelta = !_.some deltaSources, (deltaSource) ->
				_.includes(image.NormalisedRepoTags, deltaSource)
			notUsedByProxyvisor = !_.some proxyvisorImages, (proxyvisorImage) ->
				_.includes(image.NormalisedRepoTags, proxyvisorImage)
			return notUsedForDelta and notUsedByProxyvisor

	_inferNextSteps: (imagesToCleanup, availableImages, current, target, stepsInProgress) =>
		currentByAppId = _.keyBy(current.local.apps ? [], 'appId')
		targetByAppId = _.keyBy(target.local.apps ? [], 'appId')
		nextSteps = []
		if !_.isEmpty(imagesToCleanup) and !_.some(stepsInProgress, (step) -> step.action == 'fetch')
			nextSteps.push({ action: 'cleanup' })
		imagesToRemove = @_unnecessaryImages(current, target, availableImages)
		_.forEach imagesToRemove, (image) ->
			nextSteps.push({ action: 'removeImage', image })
		allAppIds = _.union(_.keys(currentByAppId), _.keys(targetByAppId))
		Promise.map allAppIds, (appId) =>
			@_nextStepsForAppUpdate(currentByAppId[appId], targetByAppId[appId], availableImages, stepsInProgress)
			.then (nextStepsForThisApp) ->
				nextSteps = nextSteps.concat(nextStepsForThisApp)
		.then =>
			return @_removeDuplicateSteps(nextSteps, stepsInProgress)

	_removeDuplicateSteps: (nextSteps, stepsInProgress) ->
		withoutProgressDups = _.filter nextSteps, (step) ->
			!_.find(stepsInProgress, (s) -> _.isEqual(s, step))?
		_.uniqWith(withoutProgressDups, _.isEqual)

	_fetchOptions: (target, step) =>
		progressReportFn = (state) =>
			# In the case of dependent apps, serviceId will be null and it will only affect global download progress
			@reportServiceStatus(target.serviceId, state)
		@config.getMany([ 'uuid', 'currentApiKey', 'resinApiEndpoint', 'deltaEndpoint'])
		.then (conf) ->
			return {
				uuid: conf.uuid
				apiKey: conf.currentApiKey
				apiEndpoint: conf.resinApiEndpoint
				deltaEndpoint: conf.deltaEndpoint
				delta: step.options.delta
				requestTimeout: step.options.deltaRequestTimeout
				applyTimeout: step.options.deltaApplyTimeout
				retryCount: step.options.deltaRetryCount
				retryInterval: step.options.deltaRetryInterval
				progressReportFn
			}

	stopAll: ({ force = false } = {}) =>
		@services.getAll()
		.map (service) =>
			Promise.using updateLock.lock(service.appId, { force }), =>
				@services.kill(service, { removeContainer: false })

	executeStepAction: (step, { force = false } = {}) =>
		if _.includes(@proxyvisor.validActions, step.action)
			return @proxyvisor.executeStepAction(step)
		if !_.includes(@validActions, step.action)
			return Promise.reject(new Error("Invalid action #{step.action}"))
		if step.options?.force?
			force = force or step.options.force
		if step.options?.skipLock
			lockFn = Promise.resolve
		else
			lockFn = updateLock.lock
		actionExecutors =
			stop: =>
				Promise.using lockFn(step.current.appId, { force }), =>
					@services.kill(step.current, { removeContainer: false })
			kill: =>
				Promise.using lockFn(step.current.appId, { force }), =>
					@services.kill(step.current)
					.then =>
						@images.removeByName(step.current.image) if step.options?.removeImage
					.then =>
						if step.options?.isRemoval
							delete @volatileState[step.current.serviceId] if @volatileState[step.current.serviceId]?
			purge: =>
				appId = step.appId
				@logger.logSystemMessage("Purging data for app #{appId}", { appId }, 'Purge data')
				Promise.using lockFn(appId, { force }), =>
					@getCurrentApp(appId)
					.then (app) =>
						throw new Error('Attempt to purge app with running services') if !_.isEmpty(app?.services)
						if _.isEmpty(app?.volumes)
							@logger.logSystemMessage('No volumes to purge', { appId }, 'Purge data noop')
							return
						Promise.mapSeries _.toPairs(app.volumes ? {}), ([ name, config ]) =>
							@volumes.remove({ name })
							.then =>
								@volumes.create({ name, config, appId })
					.then =>
						@logger.logSystemMessage('Purged data', { appId }, 'Purge data success')
				.catch (err) =>
					@logger.logSystemMessage("Error purging data: #{err}", { appId, error: err }, 'Purge data error')
					throw err
			restart: =>
				Promise.using lockFn(step.current.appId, { force }), =>
					Promise.try =>
						@services.kill(step.current)
					.then =>
						@services.start(step.target)
			stopAll: =>
				@stopAll({ force })
			start: =>
				@services.start(step.target)
			handover: =>
				Promise.using lockFn(step.current.appId, { force }), =>
					@services.handover(step.current, step.target)
			fetch: =>
				@_fetchOptions(step.target, step)
				.then (opts) =>
					@downloadsInProgress += 1
					if @downloadsInProgress == 1
						@globalAppStatus.status = 'Downloading'
						@globalAppStatus.download_progress = 0
						@reportCurrentState(@globalAppStatus)
					@images.fetch(step.target.image, opts)
				.finally =>
					@downloadsInProgress -= 1
					if @downloadsInProgress == 0
						@reportCurrentState(update_downloaded: true)
						@globalAppStatus.status = 'Idle'
						@globalAppStatus.download_progress = null
						@reportCurrentState(@globalAppStatus)
			removeImage: =>
				@images.remove(step.image)
			cleanup: =>
				@images.cleanup()
			createNetworkOrVolume: =>
				model = if step.model is 'volume' then @volumes else @networks
				model.create(step.target)
			removeNetworkOrVolume: =>
				model = if step.model is 'volume' then @volumes else @networks
				model.remove(step.current)
		actionExecutors[step.action]()

	getRequiredSteps: (currentState, targetState, stepsInProgress) =>
		Promise.join(
			@images.getDanglingAndOldSupervisorsForCleanup()
			@images.getAll()
			(imagesToCleanup, availableImages) =>
				@_inferNextSteps(imagesToCleanup, availableImages, currentState, targetState, stepsInProgress)
				.then (nextSteps) =>
					@proxyvisor.getRequiredSteps(availableImages, currentState, targetState, nextSteps.concat(stepsInProgress))
					.then (proxyvisorSteps) ->
						return nextSteps.concat(proxyvisorSteps)
		)
