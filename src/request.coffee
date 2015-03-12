config = require './config'
PlatformAPI = require 'pinejs-client'
Promise = require 'bluebird'
request = require 'request'
url = require 'url'

requestOpts =
	gzip: true
	timeout: 30000

PLATFORM_ENDPOINT = url.resolve(config.apiEndpoint, '/ewa/')
exports.resinApi = resinApi = new PlatformAPI
	apiPrefix: PLATFORM_ENDPOINT
	passthrough: requestOpts
exports.cachedResinApi = resinApi.clone({}, cache: {})


request = request.defaults(requestOpts)

exports.request = Promise.promisifyAll(request)
