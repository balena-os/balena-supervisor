Promise = require 'bluebird'
request = require 'request'
resumable = require 'resumable-request'

constants = require './constants'
osRelease = require './os-release'

osVersion = osRelease.getOSVersionSync(constants.hostOSVersionPath)
osVariant = osRelease.getOSVariantSync(constants.hostOSVersionPath)
supervisorVersion = require('./supervisor-version')

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

exports.requestOpts =
	gzip: true
	timeout: DEFAULT_REQUEST_TIMEOUT
	headers:
		'User-Agent': userAgent

resumableOpts =
	timeout: DEFAULT_REQUEST_TIMEOUT
	maxRetries: DEFAULT_REQUEST_RETRY_COUNT
	retryInterval: DEFAULT_REQUEST_RETRY_INTERVAL

request = request.defaults(exports.requestOpts)

exports.request = Promise.promisifyAll(request, multiArgs: true)
exports.resumable = resumable.defaults(resumableOpts)
