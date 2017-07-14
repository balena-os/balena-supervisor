Promise = require 'bluebird'
request = require 'request'

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

exports.requestOpts =
	gzip: true
	timeout: 30000
	headers:
		'User-Agent': userAgent

request = request.defaults(exports.requestOpts)

exports.request = Promise.promisifyAll(request, multiArgs: true)
