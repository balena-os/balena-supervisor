url = require 'url'
PlatformAPI = require 'pinejs-client'
{ request, requestOpts } = require './request'

module.exports = ({ config, db }) ->
	binder = {
		resinApi = null
		cachedResinApi = null
	}

	binder.startTargetStatePoll = ->
		# request from the target state endpoint, and store to knex app, dependentApp and config
	binder.startCurrentStateReport = ->
		# patch to the device(id) endpoint

	binder.init = ->
		config.getMany([ 'offlineMode', 'resinApiEndpoint' ])
		.spread (offlineMode, apiEndpoint) ->
			return if offlineMode
			baseUrl = url.resolve(apiEndpoint, '/v2/')
			binder.resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			binder.cachedResinApi = resinApi.clone({}, cache: {})
			provisionDevice()
			.then ->
				binder.startCurrentStateReport()
			.then ->
				binder.startTargetStatePoll()

	return binder
