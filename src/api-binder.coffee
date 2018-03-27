Promise = require 'bluebird'
_ = require 'lodash'
url = require 'url'
TypedError = require 'typed-error'
PinejsClient = require 'pinejs-client'
deviceRegister = require 'resin-register-device'
express = require 'express'
bodyParser = require 'body-parser'
Lock = require 'rwlock'
{ request, requestOpts } = require './lib/request'
{ checkTruthy } = require './lib/validation'
debugLib = require './lib/debug'

DuplicateUuidError = (err) ->
	_.startsWith(err.message, '"uuid" must be unique')

ExchangeKeyError = class ExchangeKeyError extends TypedError

REPORT_SUCCESS_DELAY = 1000
REPORT_RETRY_DELAY = 5000

createAPIBinderRouter = (apiBinder) ->
	router = express.Router()
	router.use(bodyParser.urlencoded(extended: true))
	router.use(bodyParser.json())
	router.post '/v1/update', (req, res) ->
		apiBinder.eventTracker.track('Update notification')
		if apiBinder.readyForUpdates
			apiBinder.getAndSetTargetState(req.body.force)
		res.sendStatus(204)
	return router

module.exports = class APIBinder
	constructor: ({ @config, @db, @deviceState, @eventTracker }) ->
		@resinApi = null
		@cachedResinApi = null
		@lastReportedState = { local: {}, dependent: {} }
		@stateForReport = { local: {}, dependent: {} }
		@lastTarget = {}
		@lastTargetStateFetch = process.hrtime()
		@_targetStateInterval = null
		@reportPending = false
		@stateReportErrors = 0
		@router = createAPIBinderRouter(this)
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@readyForUpdates = false
		@debug = debugLib('ApiBinder', @config)

	healthcheck: =>
		@config.getMany([ 'appUpdatePollInterval', 'offlineMode', 'connectivityCheckEnabled' ])
		.then (conf) =>
			if conf.offlineMode
				return true
			timeSinceLastFetch = process.hrtime(@lastTargetStateFetch)
			timeSinceLastFetchMs = timeSinceLastFetch[0] * 1000 + timeSinceLastFetch[1] / 1e6
			stateFetchHealthy = timeSinceLastFetchMs < 2 * conf.appUpdatePollInterval
			stateReportHealthy = !conf.connectivityCheckEnabled or !@deviceState.connected or @stateReportErrors < 3
			@debug("Healthcheck - fetchHealthy: #{stateFetchHealthy}, reportHealthy: #{stateReportHealthy}")
			return stateFetchHealthy and stateReportHealthy

	_lockGetTarget: =>
		@_writeLock('getTarget').disposer (release) ->
			release()

	initClient: =>
		@config.getMany([ 'offlineMode', 'resinApiEndpoint', 'currentApiKey'  ])
		.then ({ offlineMode, resinApiEndpoint, currentApiKey }) =>
			if offlineMode
				console.log('Offline Mode is set, skipping API client initialization')
				return
			baseUrl = url.resolve(resinApiEndpoint, '/v4/')
			passthrough = _.cloneDeep(requestOpts)
			passthrough.headers ?= {}
			passthrough.headers.Authorization = "Bearer #{currentApiKey}"
			@resinApi = new PinejsClient
				apiPrefix: baseUrl
				passthrough: passthrough
			baseUrlLegacy = url.resolve(resinApiEndpoint, '/v2/')
			@resinApiLegacy = new PinejsClient
				apiPrefix: baseUrlLegacy
				passthrough: passthrough
			@cachedResinApi = @resinApi.clone({}, cache: {})

	start: =>
		@config.getMany([ 'offlineMode', 'bootstrapRetryDelay' ])
		.then ({ offlineMode, bootstrapRetryDelay }) =>
			if offlineMode
				console.log('Offline Mode is set, skipping API binder initialization')
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
			return null

	fetchDevice: (uuid, apiKey, timeout) =>
		reqOpts = {
			resource: 'device'
			options:
				filter:
					uuid: uuid
			passthrough:
				headers: Authorization: "Bearer #{apiKey}"
		}
		@resinApi.get(reqOpts)
		.get(0)
		.catchReturn(null)
		.tap (dev) -> @debug("Device info fetched: #{dev}")
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
				@debug('Provisioner: Using existing device api key')
				return device
			# If it's not valid/doesn't exist then we try to use the user/provisioning api key for the exchange
			@fetchDevice(opts.uuid, opts.provisioningApiKey, opts.apiTimeout)
			.tap (device) ->
				if not device?
					throw new ExchangeKeyError("Couldn't fetch device with provisioning key")
				@debug('Provisioner: Registering device api key')
				# We found the device, we can try to register a working device key for it
				request.postAsync("#{opts.apiEndpoint}/api-key/device/#{device.id}/device-key", {
					json: true
					body:
						apiKey: opts.deviceApiKey
					headers:
						Authorization: "Bearer #{opts.provisioningApiKey}"
				})
				.spread (res, body) ->
					if res.statusCode != 200
						throw new ExchangeKeyError("Couldn't register device key with provisioning key")
				.timeout(opts.apiTimeout)

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
			Promise.try =>
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
				@resinApi.passthrough.headers.Authorization = "Bearer #{opts.deviceApiKey}"
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
				belongs_to__user: conf.userId
				is_managed_by__device: conf.deviceId
				uuid: deviceRegister.generateUniqueKey()
				logs_channel: deviceRegister.generateUniqueKey()
				registered_at: Math.floor(Date.now() / 1000)
			})
			@debug("Provisioning dependent device with params #{JSON.stringify(device, null, 2)}")
			@resinApi.post
				resource: 'device'
				body: device
			.timeout(conf.apiTimeout)

	# This uses resin API v2 for now, as the proxyvisor expects to be able to patch the device's commit
	patchDevice: (id, updatedFields) =>
		@config.getMany([
			'offlineMode'
			'provisioned'
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
			.timeout(conf.apiTimeout)

	_sendLogsRequest: (uuid, data) =>
		reqBody = _.map(data, (msg) -> _.mapKeys(msg, (v, k) -> _.snakeCase(k)))
		@config.get('resinApiEndpoint')
		.then (resinApiEndpoint) =>
			endpoint = url.resolve(resinApiEndpoint, "/device/v2/#{uuid}/logs")
			requestParams = _.extend
				method: 'POST'
				url: endpoint
				body: reqBody
			, @cachedResinApi.passthrough

			@cachedResinApi._request(requestParams)

	logDependent: (uuid, msg) =>
		@_sendLogsRequest(uuid, [ msg ])

	logBatch: (messages) =>
		@config.get('uuid')
		.then (uuid) =>
			@_sendLogsRequest(uuid, messages)

	# Creates the necessary config vars in the API to match the current device state,
	# without overwriting any variables that are already set.
	_reportInitialEnv: =>
		Promise.join(
			@deviceState.getCurrentForComparison()
			@getTargetState()
			@deviceState.deviceConfig.getDefaults()
			@config.get('deviceId')
			(currentState, targetState, defaultConfig, deviceId) =>
				currentConfig = currentState.local.config
				targetConfig = targetState.local.config
				Promise.mapSeries _.toPairs(currentConfig), ([ key, value ]) =>
					# We never want to disable VPN if, for instance, it failed to start so far
					if key == 'RESIN_SUPERVISOR_VPN_CONTROL'
						value = 'true'
					if !targetConfig[key]? and value != defaultConfig[key]
						envVar = {
							value
							device: deviceId
							name: key
						}
						@debug("Reporting initial env: #{JSON.stringify(envVar, null, 2)}")
						@resinApi.post
							resource: 'device_config_variable'
							body: envVar
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
		@config.getMany([ 'uuid', 'resinApiEndpoint', 'apiTimeout' ])
		.then ({ uuid, resinApiEndpoint, apiTimeout }) =>
			endpoint = url.resolve(resinApiEndpoint, "/device/v2/#{uuid}/state")

			requestParams = _.extend
				method: 'GET'
				url: "#{endpoint}"
			, @cachedResinApi.passthrough

			@debug('Retrieving target state')
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
		.finally =>
			@lastTargetStateFetch = process.hrtime()

	_pollTargetState: =>
		@config.get('appUpdatePollInterval')
		.then (appUpdatePollInterval) =>
			if @_targetStateInterval?
				clearInterval(@_targetStateInterval)
			@_targetStateInterval = setInterval(@getAndSetTargetState, appUpdatePollInterval)
			@getAndSetTargetState()
			return null

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
		return _.pickBy(diff, _.negate(_.isEmpty))

	_sendReportPatch: (stateDiff, conf) =>
		@debug("Sending to the patch endpoint: \n #{JSON.stringify(stateDiff, null, 2)}")
		endpoint = url.resolve(conf.resinApiEndpoint, "/device/v2/#{conf.uuid}/state")
		requestParams = _.extend
			method: 'PATCH'
			url: "#{endpoint}"
			body: stateDiff
		, @cachedResinApi.passthrough

		@cachedResinApi._request(requestParams)

	_report: =>
		@config.getMany([ 'deviceId', 'apiTimeout', 'resinApiEndpoint', 'uuid' ])
		.then (conf) =>
			stateDiff = @_getStateDiff()
			if _.size(stateDiff) is 0
				return

			@_sendReportPatch(stateDiff, conf)
			.timeout(conf.apiTimeout)
			.then =>
				@stateReportErrors = 0
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
			@stateReportErrors += 1
			@eventTracker.track('Device state report failure', { error: err })
			Promise.delay(REPORT_RETRY_DELAY)
			.then =>
				@_reportCurrentState()
		return null

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
