url = require 'url'
PlatformAPI = require 'pinejs-client'
{ request, requestOpts } = require './request'

module.exports = ({ config, db, deviceState }) ->
	binder = {
		resinApi: null
		cachedResinApi: null
		lastReportedState: {}
	}

	binder.provisionDevice =  ->
		throw new Error('Trying to provision device without initializing API client') if !binder.resinApi?

	binder.startTargetStatePoll = ->
		# request from the target state endpoint, and store to knex app, dependentApp and config
		throw new Error('Trying to start poll without initializing API client') if !binder.resinApi?
	binder.startCurrentStateReport = ->
		throw new Error('Trying to start state reporting without initializing API client') if !binder.resinApi?
		# patch to the device(id) endpoint
		deviceState.getCurrent()
		.then (currentDeviceState) ->



	binder.init = ->
		config.getMany([ 'offlineMode', 'resinApiEndpoint' ])
		.spread (offlineMode, apiEndpoint) ->
			return if offlineMode
			baseUrl = url.resolve(apiEndpoint, '/v2/')
			binder.resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			binder.cachedResinApi = binder.resinApi.clone({}, cache: {})
			binder.provisionDevice()
			.then ->
				binder.startCurrentStateReport()
			.then ->
				binder.startTargetStatePoll()

	return binder
