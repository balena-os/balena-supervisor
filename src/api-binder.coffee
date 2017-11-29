Promise = require 'bluebird'
_ = require 'lodash'
url = require 'url'
TypedError = require 'typed-error'
PlatformAPI = require 'pinejs-client'
deviceRegister = require 'resin-register-device'
express = require 'express'
bodyParser = require 'body-parser'
Lock = require 'rwlock'
{ request, requestOpts } = require './lib/request'
{ checkTruthy } = require './lib/validation'

DuplicateUuidError = (err) ->
	_.startsWith(err.message, '"uuid" must be unique')

ExchangeKeyError = class ExchangeKeyError extends TypedError

REPORT_SUCCESS_DELAY = 1000
REPORT_RETRY_DELAY = 5000

class APIBinderRouter
	constructor: (@apiBinder) ->
		{ @eventTracker } = @apiBinder
		@router = express.Router()
		@router.use(bodyParser.urlencoded(extended: true))
		@router.use(bodyParser.json())
		@router.post '/v1/update', (req, res) =>
			@eventTracker.track('Update notification')
			if @apiBinder.readyForUpdates
				@apiBinder.getAndSetTargetState(req.body.force)
			res.sendStatus(204)

module.exports = class APIBinder
	constructor: ({ @config, @db, @deviceState, @eventTracker }) ->
		@resinApi = null
		@cachedResinApi = null
		@lastReportedState = { local: {}, dependent: {} }
		@stateForReport = { local: {}, dependent: {} }
		@lastTarget = {}
		@_targetStateInterval = null
		@reportPending = false
		@_router = new APIBinderRouter(this)
		@router = @_router.router
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@readyForUpdates = false

	_lockGetTarget: =>
		@_writeLock('getTarget').disposer (release) ->
			release()

	init: (startServices = true) ->
		@config.getMany([ 'offlineMode', 'resinApiEndpoint', 'bootstrapRetryDelay' ])
		.then ({ offlineMode, resinApiEndpoint, bootstrapRetryDelay }) =>
			if offlineMode
				console.log('Offline Mode is set, skipping API binder initialization')
				return
			baseUrl = url.resolve(resinApiEndpoint, '/v4/')
			@resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			baseUrlLegacy = url.resolve(resinApiEndpoint, '/v2/')
			@resinApiLegacy = new PlatformAPI
				apiPrefix: baseUrlLegacy
				passthrough: requestOpts
			@cachedResinApi = @resinApi.clone({}, cache: {})
			if !startServices
				return
			console.log('Ensuring device is provisioned')
			@provisionDevice()
			.then =>
				@config.get('initialConfigReported')
				.then (reported) =>
					if !checkTruthy(reported)
						console.log('Reporting initial configuration')
						@reportInitialConfig(bootstrapRetryDelay)
			.then =>
				console.log('Starting current state report')
				@startCurrentStateReport()
			.then =>
				@readyForUpdates = true
				console.log('Starting target state poll')
				@startTargetStatePoll()
			return

	fetchDevice: (uuid, apiKey, timeout) =>
		@resinApi.get
			resource: 'device'
			options:
				filter:
					uuid: uuid
			customOptions:
				apikey: apiKey
		.get(0)
		.catchReturn(null)
		.timeout(timeout)

	_exchangeKeyAndGetDevice: (opts) ->
		Promise.try =>
			if !opts?
				@config.get('provisioningOptions')
				.then (conf) ->
					opts = conf
		.then =>
			# If we have an existing device key we first check if it's valid, because if it is we can just use that
			if opts.deviceApiKey?
				@fetchDevice(opts.uuid, opts.deviceApiKey, opts.apiTimeout)
		.then (device) =>
			if device?
				return device
			# If it's not valid/doesn't exist then we try to use the user/provisioning api key for the exchange
			@fetchDevice(opts.uuid, opts.provisioningApiKey, opts.apiTimeout)
			.then (device) ->
				if not device?
					throw new ExchangeKeyError("Couldn't fetch device with provisioning key")
				# We found the device, we can try to register a working device key for it
				request.postAsync("#{opts.apiEndpoint}/api-key/device/#{device.id}/device-key?apikey=#{opts.provisioningApiKey}", {
					json: true
					body:
						apiKey: opts.deviceApiKey
				})
				.spread (res, body) ->
					if res.statusCode != 200
						throw new ExchangeKeyError("Couldn't register device key with provisioning key")
				.timeout(opts.apiTimeout)
				.return(device)

	_exchangeKeyAndGetDeviceOrRegenerate: (opts) =>
		@_exchangeKeyAndGetDevice(opts)
		.tap ->
			console.log('Key exchange succeeded, all good')
		.tapCatch ExchangeKeyError, (err) =>
			# If it fails we just have to reregister as a provisioning key doesn't have the ability to change existing devices
			console.log('Exchanging key failed, having to reregister')
			@config.regenerateRegistrationFields()

	_provision: =>
		@config.get('provisioningOptions')
		.then (opts) =>
			if opts.registered_at? and opts.deviceId? and !opts.provisioningApiKey?
				return
			Promise.try ->
				if opts.registered_at? and !opts.deviceId?
					console.log('Device is registered but no device id available, attempting key exchange')
					@_exchangeKeyAndGetDeviceOrRegenerate(opts)
				else if !opts.registered_at?
					console.log('New device detected. Provisioning...')
					deviceRegister.register(opts)
					.timeout(opts.apiTimeout)
					.catch DuplicateUuidError, =>
						console.log('UUID already registered, trying a key exchange')
						@_exchangeKeyAndGetDeviceOrRegenerate(opts)
					.tap ->
						opts.registered_at = Date.now()
				else if opts.provisioningApiKey?
					console.log('Device is registered but we still have an apiKey, attempting key exchange')
					@_exchangeKeyAndGetDevice(opts)
			.then ({ id }) =>
				configToUpdate = {
					registered_at: opts.registered_at
					deviceId: id
					apiKey: null
				}
				@config.set(configToUpdate)
			.then =>
				@eventTracker.track('Device bootstrap success')

	_provisionOrRetry: (retryDelay) =>
		@eventTracker.track('Device bootstrap')
		@_provision()
		.catch (err) =>
			@eventTracker.track('Device bootstrap failed, retrying', { error: err, delay: retryDelay })
			Promise.delay(retryDelay).then =>
				@_provisionOrRetry(retryDelay)

	provisionDevice: =>
		if !@resinApi?
			throw new Error('Trying to provision device without initializing API client')
		@config.getMany([
			'provisioned'
			'bootstrapRetryDelay'
			'apiKey'
		])
		.tap (conf) =>
			if !conf.provisioned or conf.apiKey?
				@_provisionOrRetry(conf.bootstrapRetryDelay)

	provisionDependentDevice: (device) =>
		@config.getMany([
			'offlineMode'
			'provisioned'
			'currentApiKey'
			'apiTimeout'
			'userId'
			'deviceId'
		])
		.then (conf) =>
			if conf.offlineMode
				throw new Error('Cannot provision dependent device in offline mode')
			if !conf.provisioned
				throw new Error('Device must be provisioned to provision a dependent device')
			# TODO: when API supports it as per https://github.com/resin-io/hq/pull/949 remove userId
			_.defaults(device, {
				user: conf.userId
				device: conf.deviceId
				uuid: deviceRegister.generateUniqueKey()
				logs_channel: deviceRegister.generateUniqueKey()
				registered_at: Math.floor(Date.now() / 1000)
			})
			@resinApi.post
				resource: 'device'
				body: device
				customOptions:
					apikey: conf.currentApiKey
			.timeout(conf.apiTimeout)

	# This uses resin API v2 for now, as the proxyvisor expects to be able to patch the device's commit
	patchDevice: (id, updatedFields) =>
		@config.getMany([
			'offlineMode'
			'provisioned'
			'currentApiKey'
			'apiTimeout'
		])
		.then (conf) =>
			if conf.offlineMode
				throw new Error('Cannot update dependent device in offline mode')
			if !conf.provisioned
				throw new Error('Device must be provisioned to update a dependent device')
			@resinApiLegacy.patch
				resource: 'device'
				id: id
				body: updatedFields
				customOptions:
					apikey: conf.currentApiKey
			.timeout(conf.apiTimeout)

	# Creates the necessary config vars in the API to match the current device state,
	# without overwriting any variables that are already set.
	_reportInitialEnv: =>
		Promise.join(
			@deviceState.getCurrentForComparison()
			@getTargetState()
			@config.getMany([ 'currentApiKey', 'deviceId' ])
			(currentState, targetState, conf) =>
				currentConfig = currentState.local.config
				targetConfig = targetState.local.config
				Promise.mapSeries _.toPairs(currentConfig), ([ key, value ]) =>
					if !targetConfig[key]?
						envVar = {
							value
							device: conf.deviceId
							name: key
						}
						@resinApi.post
							resource: 'device_config_variable'
							body: envVar
							customOptions:
								apikey: conf.currentApiKey
		)
		.then =>
			@config.set({ initialConfigReported: 'true' })

	reportInitialConfig: (retryDelay) =>
		@_reportInitialEnv()
		.catch (err) =>
			console.error('Error reporting initial configuration, will retry', err)
			Promise.delay(retryDelay)
			.then =>
				@reportInitialConfig(retryDelay)

	getTargetState: =>
		@config.getMany([ 'uuid', 'currentApiKey', 'resinApiEndpoint', 'apiTimeout' ])
		.then ({ uuid, currentApiKey, resinApiEndpoint, apiTimeout }) =>
			endpoint = url.resolve(resinApiEndpoint, "/device/v2/#{uuid}/state")

			requestParams = _.extend
				method: 'GET'
				url: "#{endpoint}?&apikey=#{currentApiKey}"
			, @cachedResinApi.passthrough

			@cachedResinApi._request(requestParams)
			.timeout(apiTimeout)

	# Get target state from API, set it on @deviceState and trigger a state application
	getAndSetTargetState: (force) =>
		Promise.using @_lockGetTarget(), =>
			@getTargetState()
			.then (targetState) =>
				if !_.isEqual(targetState, @lastTarget)
					@deviceState.setTarget(targetState)
					.then =>
						@lastTarget = _.cloneDeep(targetState)
						@deviceState.triggerApplyTarget({ force })
		.catch (err) ->
			console.error("Failed to get target state for device: #{err}")

	_pollTargetState: =>
		if @_targetStateInterval?
			clearInterval(@_targetStateInterval)
			@_targetStateInterval = null
		@config.get('appUpdatePollInterval')
		.then (appUpdatePollInterval) =>
			@_targetStateInterval = setInterval(@getAndSetTargetState, appUpdatePollInterval)
			@getAndSetTargetState()
			return

	startTargetStatePoll: ->
		if !@resinApi?
			throw new Error('Trying to start poll without initializing API client')
		@_pollTargetState()
		@config.on 'change', (changedConfig) =>
			if changedConfig.appUpdatePollInterval?
				@_pollTargetState()

	_getStateDiff: =>
		diff = {
			local: _.omitBy @stateForReport.local, (val, key) =>
				_.isEqual(@lastReportedState.local[key], val)
			dependent: _.omitBy @stateForReport.dependent, (val, key) =>
				_.isEqual(@lastReportedState.dependent[key], val)
		}
		return _.pickBy(diff, (val) -> !_.isEmpty(val))

	_sendReportPatch: (stateDiff, conf) =>
		endpoint = url.resolve(conf.resinApiEndpoint, "/device/v2/#{conf.uuid}/state")
		requestParams = _.extend
			method: 'PATCH'
			url: "#{endpoint}?&apikey=#{conf.currentApiKey}"
			body: stateDiff
		, @cachedResinApi.passthrough

		@cachedResinApi._request(requestParams)

	_report: =>
		@config.getMany([ 'currentApiKey', 'deviceId', 'apiTimeout', 'resinApiEndpoint', 'uuid' ])
		.then (conf) =>
			stateDiff = @_getStateDiff()
			if _.size(stateDiff) is 0
				return
			@_sendReportPatch(stateDiff, conf)
			.timeout(conf.apiTimeout)
			.then =>
				_.assign(@lastReportedState.local, stateDiff.local)
				_.assign(@lastReportedState.dependent, stateDiff.dependent)

	_reportCurrentState: =>
		@reportPending = true
		@deviceState.getStatus()
		.then (currentDeviceState) =>
			_.assign(@stateForReport.local, currentDeviceState.local)
			_.assign(@stateForReport.dependent, currentDeviceState.dependent)
			stateDiff = @_getStateDiff()
			if _.size(stateDiff) is 0
				@reportPending = false
				return
			@_report()
			.delay(REPORT_SUCCESS_DELAY)
			.then =>
				@_reportCurrentState()
		.catch (err) =>
			@eventTracker.track('Device state report failure', { error: err })
			Promise.delay(REPORT_RETRY_DELAY)
			.then =>
				@_reportCurrentState()
		return

	startCurrentStateReport: =>
		if !@resinApi?
			throw new Error('Trying to start state reporting without initializing API client')
		# patch to the device(id) endpoint
		@deviceState.on 'change', =>
			if !@reportPending
				# A latency of 100 ms should be acceptable and
				# allows avoiding catching docker at weird states
				@_reportCurrentState()
		@_reportCurrentState()
