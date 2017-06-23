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


	binder.startTargetStatePoll = ->
		# request from the target state endpoint, and store to knex app, dependentApp and config
	binder.startCurrentStateReport = ->
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
