config = require './config'
url = require 'url'
PlatformAPI = require 'pinejs-client'
request = require './request'

resinApi = null
cachedResinApi = null

initClients = ->
	config.init
	.then ->
		config.get('apiEndpoint')
	.then (apiEndpoint) ->
		if apiEndpoint?
			baseUrl = url.resolve(apiEndpoint, '/v2/')
			resinApi = resinApi = new PlatformAPI
				apiPrefix: baseUrl
				passthrough: requestOpts
			cachedResinApi = resinApi.clone({}, cache: {})
			return { resinApi, cachedResinApi }
		else
			return { resinApi: {}, cachedResinApi: {} }

startTargetStatePoll = ->
	initClients
	.then ({ resinApi, cachedResinApi }) ->
		pollInterval = setInterval()

startCurrentStateReport = ->
	initClients
	.then ({ resinApi, cachedResinApi }) ->
		setInterval()

exports.initialize = ->
	initClients
	.then ({ resinApi, cachedResinApi }) ->
		config.get()
				provisionDevice()
		.then ->
			startTargetStatePoll()
		.then ->
			startCurrentStateReport()
