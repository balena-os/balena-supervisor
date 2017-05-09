config = require './config'
PlatformAPI = require 'pinejs-client'
Promise = require 'bluebird'
request = require 'request'
url = require 'url'
osRelease = require './lib/os-release'

osVersion = osRelease.getOSVersionSync(config.hostOSVersionPath)
osVariant = osRelease.getOSVariantSync(config.hostOSVersionPath)
supervisorVersion = require('./lib/supervisor-version')

userAgent = "Supervisor/#{supervisorVersion}"
if osVersion?
	if osVariant?
		userAgent += " (Linux; #{osVersion}; #{osVariant})"
	else
		userAgent += " (Linux; #{osVersion})"

requestOpts =
	gzip: true
	timeout: 30000
	headers:
		'User-Agent': userAgent

PLATFORM_ENDPOINT = url.resolve(config.apiEndpoint, '/v2/')
exports.resinApi = resinApi = new PlatformAPI
	apiPrefix: PLATFORM_ENDPOINT
	passthrough: requestOpts
exports.cachedResinApi = resinApi.clone({}, cache: {})


request = request.defaults(requestOpts)

exports.request = Promise.promisifyAll(request, multiArgs: true)
