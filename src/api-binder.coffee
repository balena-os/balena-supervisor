url = require 'url'
PlatformAPI = require 'pinejs-client'
{ request, requestOpts } = require './request'

module.exports = class APIBinder
	constructor: ({ @config, @db, @deviceState }) ->
		@resinApi = null
		@cachedResinApi = null
		@lastReportedState = {}
		@_targetStateInterval = null

	init: ->
		@config.getMany([ 'offlineMode', 'resinApiEndpoint' ])
		.then ({ offlineMode, apiEndpoint }) =>
			return if offlineMode
			baseUrl = url.resolve(apiEndpoint, '/v2/')
			@resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			@cachedResinApi = @resinApi.clone({}, cache: {})
			@provisionDevice()
			.then =>
				@startCurrentStateReport()
			.then =>
				@startTargetStatePoll()

	provisionDevice: ->
		throw new Error('Trying to provision device without initializing API client') if !@resinApi?
		@config.getMany([
			'provisioned'
			'initialEnvReported'
			'bootstrapRetryDelay'
			'uuid'
			'apiKey'
			'deviceApiKey'
		])
		.then (conf) =>
			if !provisioned
				console.log('New device detected. Bootstrapping..')
				@_provision()
		.then =>
			# Perform the key exchange
			@exchangeKey()
		.then =>
			@reportInitialEnv(conf.bootstrapRetryDelay) if !initialEnvReported


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
		.then ->
			Promise.delay

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

	getAndSetTargetState: ->

	_pollTargetState: ->
		if @_targetStateInterval?
			clearInterval(@_targetStateInterval)
			@_targetStateInterval = null
		@config.get('appUpdatePollInterval')
		.then (appUpdatePollInterval) ->
			@_targetStateInterval = setInterval(@getAndSetTargetState, appUpdatePollInterval)
			@getAndSetTargetState()
			return

	startTargetStatePoll: ->
		# request from the target state endpoint, and store to knex app, dependentApp and config
		throw new Error('Trying to start poll without initializing API client') if !@resinApi?
		@_pollTargetState()
		@config.on 'change', (changedConfig) ->
			@_pollTargetState() if changedConfig.appUpdatePollInterval?

	_reportCurrentState: =>
		@deviceState.getCurrent()
		.then (currentDeviceState) ->

	startCurrentStateReport: ->
		throw new Error('Trying to start state reporting without initializing API client') if !@resinApi?
		# patch to the device(id) endpoint
		@deviceState.on('current-state-change', @_reportCurrentState)
