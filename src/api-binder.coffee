url = require 'url'
PlatformAPI = require 'pinejs-client'
{ request, requestOpts } = require './request'

module.exports = class APIBinder
	constructor: ({ config, db, deviceState }) ->
		@config = config
		@db = db
		@deviceState = deviceState
		@resinApi = null
		@cachedResinApi = null
		@lastReportedState = {}

	init: ->
		@config.getMany([ 'offlineMode', 'resinApiEndpoint' ])
		.spread (offlineMode, apiEndpoint) =>
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

	startTargetStatePoll: ->
		# request from the target state endpoint, and store to knex app, dependentApp and config
		throw new Error('Trying to start poll without initializing API client') if !@resinApi?
	startCurrentStateReport: ->
		throw new Error('Trying to start state reporting without initializing API client') if !@resinApi?
		# patch to the device(id) endpoint
		@deviceState.getCurrent()
		.then (currentDeviceState) ->
