config = require './config'
PlatformAPI = require 'pinejs-client'
Promise = require 'bluebird'
request = require 'request'
resumable = require 'resumable-request'
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

# With these settings, the device must be unable to receive a single byte
# from the network for a continuous period of 20 minutes before we give up.
# (reqTimeout + retryInterval) * retryCount / 1000ms / 60sec ~> minutes
DEFAULT_REQUEST_TIMEOUT = 30000 # ms
DEFAULT_REQUEST_RETRY_INTERVAL = 10000 # ms
DEFAULT_REQUEST_RETRY_COUNT = 30

requestOpts =
	gzip: true
	timeout: DEFAULT_REQUEST_TIMEOUT
	headers:
		'User-Agent': userAgent

resumableOpts =
	timeout: DEFAULT_REQUEST_TIMEOUT
	maxRetries: DEFAULT_REQUEST_RETRY_COUNT
	retryInterval: DEFAULT_REQUEST_RETRY_INTERVAL

try
	PLATFORM_ENDPOINT = url.resolve(config.apiEndpoint, '/v2/')
	exports.resinApi = resinApi = new PlatformAPI
		apiPrefix: PLATFORM_ENDPOINT
		passthrough: requestOpts
	exports.cachedResinApi = resinApi.clone({}, cache: {})
catch
	exports.resinApi = {}
	exports.cachedResinApi = {}

request = request.defaults(requestOpts)

exports.request = Promise.promisifyAll(request, multiArgs: true)

exports.resumable = resumable.defaults(resumableOpts)
