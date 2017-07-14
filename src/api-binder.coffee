Promise = require 'bluebird'
_ = require 'lodash'
url = require 'url'
semver = require 'semver'
semverRegex = require 'semver-regex'
TypedError = require 'typed-error'
PlatformAPI = require 'pinejs-client'
deviceRegister = require 'resin-register-device'

{ request, requestOpts } = require './lib/request'

DuplicateUuidError = message: '"uuid" must be unique.'
ExchangeKeyError = class ExchangeKeyError extends TypedError

hasDeviceApiKeySupport = (osVersion) ->
	try
		osSemver = semverRegex().exec(osVersion)[0]
		!/^Resin OS /.test(osVersion) or semver.gte(osSemver, '2.0.2')
	catch err
		console.error(osVersion)
		console.error('Unable to determine if device has deviceApiKey support', err, err.stack)
		false

module.exports = class APIBinder
	constructor: ({ @config, @db, @deviceState, @eventTracker }) ->
		@resinApi = null
		@cachedResinApi = null
		@lastReportedState = {}
		@_targetStateInterval = null

	init: (startServices = true) ->
		@config.getMany([ 'offlineMode', 'resinApiEndpoint' ])
		.then ({ offlineMode, resinApiEndpoint }) =>
			if offlineMode
				console.log('Offline Mode is set, skipping API binder initialization')
				return
			baseUrl = url.resolve(resinApiEndpoint, '/v2/')
			@resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			@cachedResinApi = @resinApi.clone({}, cache: {})
			return if !startServices
			console.log('Ensuring provisioning')
			@provisionDevice()
			.then =>
				@config.get('initialConfigReported')
				.then (reported) =>
					console.log('Reporting initial configuration')
					@reportInitialConfig if !reported
			.then =>
				console.log('Starting current state report')
				@startCurrentStateReport()
			.then =>
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

	exchangeKeyAndGetDevice: (opts) ->
		Promise.try =>
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
		@exchangeKeyAndGetDevice(opts)
		.tap ->
			console.log('Key exchange succeeded, all good')
		.tapCatch ExchangeKeyError, (err) =>
			# If it fails we just have to reregister as a provisioning key doesn't have the ability to change existing devices
			console.log('Exchanging key failed, having to reregister')
			@config.regenerateRegistrationFields()

	_provision: =>
		@config.get('provisioningOptions')
		.then (opts) =>
			Promise.try ->
				if opts.registered_at? && !opts.deviceId?
					console.log('Device is registered but no device id available, attempting key exchange')
					@_exchangeKeyAndGetDeviceOrRegenerate(opts)
				else
					deviceRegister.register(opts)
					.timeout(opts.apiTimeout)
					.catch DuplicateUuidError, =>
						console.log('UUID already registered, trying a key exchange')
						@_exchangeKeyAndGetDeviceOrRegenerate(opts)
					.tap ->
						opts.registered_at = Date.now()
			.then ({ id }) =>
				opts.deviceId = id
				@config.get('osVersion')
			.then (osVersion) =>
				configToUpdate = {
					registered_at: opts.registered_at
					deviceId: opts.deviceId
				}
				# Delete the provisioning key now, only if the OS supports it
				hasSupport = hasDeviceApiKeySupport(osVersion)
				if hasSupport
					configToUpdate.apiKey = null
				else
					configToUpdate.apiKey = opts.deviceApiKey
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
		throw new Error('Trying to provision device without initializing API client') if !@resinApi?
		@config.getMany([
			'provisioned'
			'bootstrapRetryDelay'
		])
		.tap (conf) =>
			if !conf.provisioned
				console.log('New device detected. Bootstrapping..')
				@_provisionOrRetry(conf.bootstrapRetryDelay)
		.tap =>
			@config.getMany([ 'apiKey', 'deviceApiKey'])
			.then ({ apiKey, deviceApiKey }) =>
				if apiKey?
					# Only do a key exchange and delete the provisioning key if we're on a Resin OS version
					# that supports using the deviceApiKey (2.0.2 and above)
					# or if we're in a non-Resin OS (which is assumed to be updated enough).
					# Otherwise VPN and other host services that use an API key will break.
					#
					# In other cases, we make the apiKey equal the deviceApiKey instead.
					@config.get('osVersion')
					.then (osVersion) =>
						hasSupport = hasDeviceApiKeySupport(osVersion)
						if hasSupport or apiKey != deviceApiKey
							console.log('Attempting key exchange')
							@exchangeKeyAndGetDevice()
							.then =>
								console.log('Key exchange succeeded, starting to use deviceApiKey')
								if hasSupport
									apiKey = null
								else
									apiKey = deviceApiKey
								@config.set({ apiKey })
					.catch (err) ->
						console.error('Error exchanging keys, will ignore since device is already provisioned', err, err.stack)

	_reportInitialEnv: ->
		Promise.join(
			@deviceState.getCurrent()
			@getTargetState()
			(currentState, targetState) ->
				targetState.local.config
		)

	reportInitialConfig: (retryDelay) ->
		@_reportInitialEnv()
		.catch (err) ->
			console.error('Error reporting initial configuration, will retry')
			Promise.delay(retryDelay)
			.then =>
				@reportInitialConfig(retryDelay)

	getTargetState: ->
		@config.getMany([ 'uuid', 'currentApiKey', 'resinApiEndpoint', 'apiTimeout' ])
		.then ({ uuid, currentApiKey, resinApiEndpoint, apiTimeout }) =>
			endpoint = url.resolve(resinApiEndpoint, "/device/v1/#{uuid}/state")

			requestParams = _.extend
				method: 'GET'
				url: "#{endpoint}?&apikey=#{currentApiKey}"
			, @cachedResinApi.passthrough

			@cachedResinApi._request(requestParams)
			.timeout(apiTimeout)
			.catch (err) ->
				console.error("Failed to get state for device #{uuid}. #{err}")
				throw err
			.then (state) ->
				state.local ?= {}
				if !state.local.config?
					state.local.config ?= {}
					_.forEach state.local?.apps, (app) ->
						_.merge(state.local.config, JSON.parse(app.config ? '{}'))
				return state

	# Get target state from API, set it on @deviceState
	getAndSetTargetState: ->

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
		# request from the target state endpoint, and store to knex app, dependentApp and config
		throw new Error('Trying to start poll without initializing API client') if !@resinApi?
		@_pollTargetState()
		@config.on 'change', (changedConfig) =>
			@_pollTargetState() if changedConfig.appUpdatePollInterval?

	_reportCurrentState: =>
		@deviceState.getCurrent()
		.then (currentDeviceState) ->

	startCurrentStateReport: ->
		throw new Error('Trying to start state reporting without initializing API client') if !@resinApi?
		# patch to the device(id) endpoint
		@deviceState.on('current-state-change', @_reportCurrentState)
