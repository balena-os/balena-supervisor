Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
express = require 'express'
bodyParser = require 'body-parser'

constants = require './lib/constants'

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

serviceAction = (action, serviceId, current, target, options) ->
	obj = { action, serviceId, current, target }
	obj.options = options if options?
	return obj

# TODO: move this to an Image class?
imageForService = (service) ->
	return {
		name: service.image
		appId: service.appId
		serviceId: service.serviceId
		serviceName: service.serviceName
		imageId: service.imageId?.toString()
		releaseId: service.releaseId?.toString()
		dependent: 0
	}

fetchAction = (service) ->
	return {
		action: 'fetch'
		image: imageForService(service)
		serviceId: service.serviceId
	}
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
				@applications.executeStepAction(serviceAction('restart', service.serviceId, service, service), { force })
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
				@applications.executeStepAction(serviceAction('stop', service.serviceId, service), { force })
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
				@applications.executeStepAction(serviceAction('start', service.serviceId, null, service), { force })
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
					commit: service.commit
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
					@applications.executeStepAction(serviceAction('kill', service.serviceId, service, null, skipLock: true), { force })
					.then =>
						@applications.executeStepAction({
							action: 'purge'
							appId: app.appId
							options:
								skipLock: true
						}, { force })
					.then =>
						@applications.executeStepAction(serviceAction('start', service.serviceId, null, service, skipLock: true), { force })
					.then ->
						res.status(200).json(Data: 'OK', Error: '')
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')
		@router.use(@proxyvisor.router)

module.exports = class ApplicationManager extends EventEmitter
	constructor: ({ @logger, @config, @db, @eventTracker }) ->
		@docker = new Docker()
		@images = new Images({ @docker, @logger, @db })
		@services = new ServiceManager({ @docker, @logger, @images, @config })
		@networks = new Networks({ @docker, @logger })
		@volumes = new Volumes({ @docker, @logger })
		@proxyvisor = new Proxyvisor({ @config, @logger, @db, @docker, @images, applications: this })
		@_targetVolatilePerServiceId = {}
		@validActions = [
			'kill'
			'start'
			'stop'
			'updateReleaseId'
			'fetch'
			'removeImage'
			'updateImage'
			'killAll'
			'purge'
			'restart'
			'cleanup'
			'createNetworkOrVolume'
			'removeNetworkOrVolume'
		].concat(@proxyvisor.validActions)
		@_router = new ApplicationManagerRouter(this)
		@router = @_router.router

		@images.on('change', @reportCurrentState)
		@services.on('change', @reportCurrentState)

	serviceAction: serviceAction
	imageForService: imageForService
	fetchAction: fetchAction

	reportCurrentState: (data) =>
		@emit('change', data)

	init: =>
		@images.cleanupDatabase()
		.then =>
			@services.attachToRunning()
		.then =>
			@services.listenToEvents()

	# Returns the status of applications and their services
	getStatus: =>
		Promise.join(
			@services.getStatus()
			@images.getStatus()
			(services, images) ->
				apps = {}
				dependent = {}
				commit = null
				# We iterate over the current running services and add them to the current state
				# of the app they belong to.
				_.forEach services, (service) ->
					appId = service.appId
					apps[appId] ?= {}
					apps[appId].services ?= {}
					# We only send commit if all services have the same
					if !commit?
						commit = service.commit
					else if commit != service.commit
						commit = false
					if !apps[appId].services[service.imageId]?
						apps[appId].services[service.imageId] = _.pick(service, [ 'status', 'releaseId' ])
						apps[appId].services[service.imageId].download_progress = null
					else
						# There's two containers with the same imageId, so this has to be a handover
						previousReleaseId = apps[appId].services[service.imageId].releaseId
						apps[appId].services[service.imageId].releaseId = Math.max(parseInt(previousReleaseId), parseInt(service.releaseId)).toString()
						apps[appId].services[service.imageId].status = 'Handing over'

				_.forEach images, (image) ->
					appId = image.appId
					if !image.dependent
						apps[appId] ?= {}
						apps[appId].services ?= {}
						apps[appId].services[image.imageId] ?= _.pick(image, [ 'status', 'download_progress', 'releaseId' ])
					else
						dependent[appId] ?= {}
						dependent[appId].images ?= {}
						dependent[appId].images[image.imageId] = _.pick(image, [ 'status', 'download_progress' ])

				obj = { local: apps, dependent }
				obj.commit = commit if commit
				return obj
		)

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
				return @_buildApps(services, networks, volumes)
		)

	getCurrentApp: (appId) =>
		Promise.join(
			@services.getAllByAppId(appId)
			@networks.getAllByAppId(appId)
			@volumes.getAllByAppId(appId)
			(services, networks, volumes) =>
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
						})
				else
					currentServicesPerId[serviceId] = currentServiceContainers[0]

			Promise.filter toBeMaybeUpdated, (serviceId) ->
				return !currentServicesPerId[serviceId].isEqual(targetServicesPerId[serviceId])
			.map (serviceId) ->
				updatePairs.push({
					current: currentServicesPerId[serviceId]
					target: targetServicesPerId[serviceId]
					serviceId
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

	# TODO: should we consider the case where several services use the same image?
	# In such case we should do more complex matching to allow several image objects
	# with the same name but different metadata. For now this shouldn't be necessary
	# because the Resin model requires a different imageId and name for each service.
	compareImagesForMetadataUpdate: (availableImages, targetServices) ->
		pairs = []
		targetImages = _.map(targetServices, imageForService)
		_.forEach targetImages, (target) ->
			imageWithSameName = _.find(availableImages, (img) -> img.name == target.name)
			return if !imageWithSameName?
			return if _.find(availableImages, (img) -> _.isEqual(_.omit(img, 'id'), target))
			pairs.push({ current: imageWithSameName, target, serviceId: target.serviceId })
		return pairs

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

	_nextStepsForNetworkOrVolume: ({ current, target }, currentApp, changingPairs, dependencyComparisonFn, model) ->
		# Check none of the currentApp.services use this network or volume
		if current?
			dependencies = _.filter currentApp.services, (service) ->
				dependencyComparisonFn(service, current)
			if _.isEmpty(dependencies)
				return [{ action: 'removeNetworkOrVolume', model, current }]
			else
				# If the current update doesn't require killing the services that use this network/volume,
				# we have to kill them before removing the network/volume (e.g. when we're only updating the network config)
				steps = []
				_.forEach dependencies, (dependency) ->
					if !_.some(changingPairs, (pair) -> pair.serviceId == dependency.serviceId)
						steps.push(serviceAction('kill', dependency.serviceId, dependency))
				return steps
		else if target?
			return [{ action: 'createNetworkOrVolume', model, target }]

	_nextStepsForNetwork: ({ current, target }, currentApp, changingPairs) =>
		dependencyComparisonFn = (service, current) ->
			service.network_mode == current.name
		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, 'network')

	_nextStepsForVolume: ({ current, target }, currentApp, changingPairs) ->
		# Check none of the currentApp.services use this network or volume
		dependencyComparisonFn = (service, current) ->
			_.some service.volumes, (volumeDefinition) ->
				sourceName = volumeDefinition.split(':')[0]
				sourceName == current.name
		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, 'volume')

	# Infers steps that do not require creating a new container
	_updateContainerStep: (current, target) ->
		if current.releaseId != target.releaseId
			return serviceAction('updateReleaseId', target.serviceId, current, target)
		else if target.running
			return serviceAction('start', target.serviceId, current, target)
		else
			return serviceAction('stop', target.serviceId, current, target)

	_fetchOrStartStep: (current, target, needsDownload, dependenciesMetFn) ->
		if needsDownload
			return fetchAction(target)
		else if dependenciesMetFn()
			return serviceAction('start', target.serviceId, current, target)
		else
			return null

	_strategySteps: {
		'download-then-kill': (current, target, needsDownload, dependenciesMetFn) ->
			if needsDownload
				return fetchAction(target)
			else if dependenciesMetFn()
				# We only kill when dependencies are already met, so that we minimize downtime
				return serviceAction('kill', target.serviceId, current, target)
			else
				return null
		'kill-then-download': (current, target, needsDownload, dependenciesMetFn) ->
			return serviceAction('kill', target.serviceId, current, target)
		'delete-then-download': (current, target, needsDownload, dependenciesMetFn) ->
			return serviceAction('kill', target.serviceId, current, target, removeImage: true)
		'hand-over': (current, target, needsDownload, dependenciesMetFn, timeout) ->
			if needsDownload
				return fetchAction(target)
			else if dependenciesMetFn()
				return serviceAction('handover', target.serviceId, current, target, timeout: timeout)
			else
				return null
	}

	_nextStepForService: ({ current, target }, updateContext) ->
		{ networkPairs, volumePairs, installPairs, updatePairs, stepsInProgress, availableImages } = updateContext
		if _.find(stepsInProgress, (step) -> step.serviceId == target.serviceId)?
			# There is already a step in progress for this service, so we wait
			return null
		dependenciesMet = =>
			@_dependenciesMetForServiceStart(target, networkPairs, volumePairs, installPairs.concat(updatePairs), stepsInProgress)

		needsDownload = !_.some(availableImages, (image) -> target.image == image.name)
		if current?.isSameContainer(target)
			# We're only stopping/starting it
			return @_updateContainerStep(current, target)
		else if !current?
			# Either this is a new service, or the current one has already been killed
			return @_fetchOrStartStep(current, target, needsDownload, dependenciesMet)
		else
			strategy = checkString(target.labels['io.resin.update.strategy'])
			validStrategies = [ 'download-then-kill', 'kill-then-download', 'delete-then-download', 'hand-over' ]
			strategy = 'download-then-kill' if !_.includes(validStrategies, strategy)
			timeout = checkInt(target.labels['io.resin.update.handover_timeout'])
			return @_strategySteps[strategy](current, target, needsDownload, dependenciesMet, timeout)

	_nextStepsForAppUpdate: (currentApp, targetApp, availableImages = [], stepsInProgress = []) =>
		emptyApp = { services: [], volumes: {}, networks: {} }
		if !targetApp?
			targetApp = emptyApp
		if !currentApp?
			currentApp = emptyApp
		appId = targetApp.appId ? currentApp.appId
		# Create the default network for the target app
		targetApp.networks[targetApp.appId] ?= {}
		Promise.join(
			@compareNetworksOrVolumesForUpdate(@networks, { current: currentApp.networks, target: targetApp.networks }, appId)
			@compareNetworksOrVolumesForUpdate(@volumes, { current: currentApp.volumes, target: targetApp.volumes }, appId)
			@compareServicesForUpdate(currentApp.services, targetApp.services)
			@compareImagesForMetadataUpdate(availableImages, targetApp.services)
			(networkPairs, volumePairs, { removePairs, installPairs, updatePairs }, imagePairs) =>
				steps = []
				# All removePairs get a 'kill' action
				_.forEach removePairs, ({ current }) ->
					steps.push(serviceAction('kill', current.serviceId, current, null))
				# next step for install pairs in download - start order, but start requires dependencies, networks and volumes met
				# next step for update pairs in order by update strategy. start requires dependencies, networks and volumes met.
				_.forEach installPairs.concat(updatePairs), (pair) =>
					step = @_nextStepForService(pair, { networkPairs, volumePairs, installPairs, updatePairs, stepsInProgress, availableImages })
					steps.push(step) if step?
				# next step for network pairs - remove requires services killed, create kill if no pairs or steps affect that service
				_.forEach networkPairs, (pair) =>
					pairSteps = @_nextStepsForNetwork(pair, currentApp, removePairs.concat(updatePairs))
					steps = steps.concat(pairSteps) if !_.isEmpty(pairSteps)
				# next step for volume pairs - remove requires services killed, create kill if no pairs or steps affect that service
				_.forEach volumePairs, (pair) =>
					pairSteps = @_nextStepsForVolume(pair, currentApp, removePairs.concat(updatePairs))
					steps = steps.concat(pairSteps) if !_.isEmpty(pairSteps)
				_.forEach imagePairs, (pair) ->
					steps.push(_.assign({ action: 'updateImage' }, pair))
				return steps
		)

	normaliseAppForDB: (app) =>
		services = _.map app.services, (s, serviceId) ->
			service = _.clone(s)
			service.appId = app.appId
			service.releaseId = app.releaseId
			service.serviceId = serviceId
			service.commit = app.commit
			return service
		Promise.map services, (service) =>
			service.image = @images.normalise(service.image)
			Promise.props(service)
		.then (services) ->
			dbApp = {
				appId: app.appId
				commit: app.commit
				name: app.name
				releaseId: app.releaseId
				services: JSON.stringify(services)
				networks: JSON.stringify(app.networks ? {})
				volumes: JSON.stringify(app.volumes ? {})
			}
			return dbApp

	createTargetService: (service, opts) ->
		NotFoundErr = (err) -> err.statusCode == 404
		serviceOpts = {
			serviceName: service.serviceName
		}
		_.assign(serviceOpts, opts)
		Promise.join(
			@images.inspectByName(service.image)
			.catchReturn(undefined)
			@docker.getNetworkGateway(service.network_mode ? service.appId)
			.catchReturn(NotFoundErr, null)
			.catchReturn(@docker.InvalidNetGatewayError, null)
			(imageInfo, apiHostForNetwork) ->
				serviceOpts.imageInfo = imageInfo
				serviceOpts.supervisorApiHost = apiHostForNetwork if apiHostForNetwork?
				return new Service(service, serviceOpts)
		)

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
				volumes = _.mapValues volumes, (volumeConfig) ->
					volumeConfig ?= {}
					volumeConfig.labels ?= {}
					return volumeConfig
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
					appsArray = _.map apps, (app, appId) ->
						appClone = _.clone(app)
						appClone.appId = appId
						return appClone
					Promise.map(appsArray, @normaliseAppForDB)
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
					_.merge(service, @_targetVolatilePerServiceId[service.serviceId]) if @_targetVolatilePerServiceId[service.serviceId]?
					return service
			return app

	getDependentTargets: =>
		@proxyvisor.getTarget()

	bestDeltaSource: (image, available) ->
		if !image.dependent
			for availableImage in available
				if availableImage.serviceName == image.serviceName and availableImage.appId == image.appId
					return availableImage.name
			for availableImage in available
				if availableImage.serviceName == image.serviceName
					return availableImage.name
		for availableImage in available
			if availableImage.appId == image.appId
				return availableImage.name
		return 'resin/scratch'

	# return images that:
	# - are not used in the current state, and
	# - are not going to be used in the target state, and
	# - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
	_unnecessaryImages: (current, target, available) =>

		allImagesForApp = (app) -> _.map(app.services, imageForService)

		currentImages = _.flatten(_.map(current.local?.apps, allImagesForApp))
		targetImages = _.flatten(_.map(target.local?.apps, allImagesForApp))
		availableAndUnused = _.filter available, (image) ->
			!_.some currentImages.concat(targetImages), (imageInUse) -> image.name == imageInUse.name
		imagesToDownload = _.filter targetImages, (imageName) ->
			!_.some available, (availableImage) -> availableImage.name == imageName.name

		deltaSources = _.map imagesToDownload, (image) =>
			return @bestDeltaSource(image, available)

		proxyvisorImages = @proxyvisor.imagesInUse(current, target)

		return _.filter availableAndUnused, (image) ->
			notUsedForDelta = !_.some deltaSources, (deltaSource) -> deltaSource == image.name
			notUsedByProxyvisor = !_.some proxyvisorImages, (proxyvisorImage) -> image.name == proxyvisorImage
			return notUsedForDelta and notUsedByProxyvisor

	_inferNextSteps: (cleanupNeeded, availableImages, current, target, stepsInProgress) =>
		Promise.try =>
			currentByAppId = _.keyBy(current.local.apps ? [], 'appId')
			targetByAppId = _.keyBy(target.local.apps ? [], 'appId')
			nextSteps = []
			if !_.some(stepsInProgress, (step) -> step.action == 'fetch')
				if cleanupNeeded
					nextSteps.push({ action: 'cleanup' })
				imagesToRemove = @_unnecessaryImages(current, target, availableImages)
				_.forEach imagesToRemove, (image) ->
					nextSteps.push({ action: 'removeImage', image })
			# If we have to remove any images, we do that before anything else
			return nextSteps if !_.isEmpty(nextSteps)
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

	stopAll: ({ force = false } = {}) =>
		@services.getAll()
		.map (service) =>
			Promise.using @_lockIfNecessary(service.appId, { force }), =>
				@services.kill(service, { removeContainer: false })

	_lockIfNecessary: (appId, { force = false, skipLock = false } = {}) =>
		return Promise.resolve() if skipLock
		@config.get('lockOverride')
		.then (lockOverride) ->
			return lockOverride or force
		.then (force) ->
			updateLock.lock(appId, { force })

	executeStepAction: (step, { force = false } = {}) =>
		if _.includes(@proxyvisor.validActions, step.action)
			return @proxyvisor.executeStepAction(step)
		if !_.includes(@validActions, step.action)
			return Promise.reject(new Error("Invalid action #{step.action}"))
		actionExecutors =
			stop: =>
				Promise.using @_lockIfNecessary(step.current.appId, { force, skipLock: step.options?.skipLock }), =>
					@services.kill(step.current, { removeContainer: false })
			kill: =>
				Promise.using @_lockIfNecessary(step.current.appId, { force, skipLock: step.options?.skipLock }), =>
					@services.kill(step.current)
					.then =>
						@images.remove(imageForService(step.current)) if step.options?.removeImage
			updateReleaseId: =>
				@services.updateReleaseId(step.current, step.target.releaseId)
			purge: =>
				appId = step.appId
				@logger.logSystemMessage("Purging data for app #{appId}", { appId }, 'Purge data')
				Promise.using @_lockIfNecessary(appId, { force, skipLock: step.options?.skipLock }), =>
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
				Promise.using @_lockIfNecessary(step.current.appId, { force, skipLock: step.options?.skipLock }), =>
					Promise.try =>
						@services.kill(step.current)
					.then =>
						@services.start(step.target)
			stopAll: =>
				@stopAll({ force })
			start: =>
				@services.start(step.target)
			handover: =>
				Promise.using @_lockIfNecessary(step.current.appId, { force, skipLock: step.options?.skipLock }), =>
					@services.handover(step.current, step.target)
			fetch: =>
				Promise.join(
					@config.get('fetchOptions')
					@images.getAvailable()
					(opts, availableImages) =>
						opts.deltaSource = @bestDeltaSource(step.image, availableImages)
						@images.fetch(step.image, opts)
				)
				.finally =>
					@reportCurrentState(update_downloaded: true)
			removeImage: =>
				@images.remove(step.image)
			updateImage: =>
				@images.update(step.target)
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
			@images.isCleanupNeeded()
			@images.getAvailable()
			(cleanupNeeded, availableImages) =>
				@_inferNextSteps(cleanupNeeded, availableImages, currentState, targetState, stepsInProgress)
				.then (nextSteps) =>
					@proxyvisor.getRequiredSteps(availableImages, currentState, targetState, nextSteps.concat(stepsInProgress))
					.then (proxyvisorSteps) ->
						return nextSteps.concat(proxyvisorSteps)
		)
