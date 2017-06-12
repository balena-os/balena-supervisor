config = require './config'

Promise = require 'bluebird'
request = require 'request'

osRelease = require './lib/os-release'

osVersion = osRelease.getOSVersionSync(config.constants.hostOSVersionPath)
osVariant = osRelease.getOSVariantSync(config.constants.hostOSVersionPath)
supervisorVersion = require('./lib/supervisor-version')

userAgent = "Supervisor/#{supervisorVersion}"
if osVersion?
	if osVariant?
		userAgent += " (Linux; #{osVersion}; #{osVariant})"
	else
		userAgent += " (Linux; #{osVersion})"

exports.requestOpts =
	gzip: true
	timeout: 30000
	headers:
		'User-Agent': userAgent

request = request.defaults(requestOpts)

exports.request = Promise.promisifyAll(request, multiArgs: true)
