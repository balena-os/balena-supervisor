Promise = require 'bluebird'
YAML = require 'yamljs'
_ = require 'lodash'
dockerUtils = require './docker-utils'
{ docker } = dockerUtils
fs = Promise.promisifyAll(require('fs'))
spawn = require('child_process').spawn

runComposeCommand = (composeArgs, path, onStatus) ->
	onStatus ?= console.log.bind(console)
	reportStatus = (status) ->
		try onStatus(status)
	new Promise (resolve, reject) ->
		child = spawn('docker-compose', ['-f', path].concat(composeArgs), stdio: 'pipe')
		.on 'error', reject
		.on 'exit', (code) ->
			return reject(new Error("docker-compose exited with code #{code}")) if code isnt 0
			resolve()
		child.stdout.on 'data', (data) ->
			reportStatus(status: '' + data)
		child.stderr.on 'data', (data) ->
			reportStatus(status: '' + data)
	.catch (err) ->
		msg = err?.message or err
		reportStatus(error: msg)
		throw err

# Runs docker-compose up using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
exports.up = (path, onStatus) ->
	onStatus ?= console.log.bind(console)
	reportStatus = (status) ->
		try onStatus(status)
	fs.readFileAsync(path)
	.then (data) ->
		YAML.parse(data.toString())
	.then (composeSpec) ->
		if composeSpec.version? && composeSpec.version == '2'
			services = composeSpec.services
		else
			services = composeSpec
		throw new Error('No services found') if !_.isObject(services)
		servicesArray = _.pairs(services)
		Promise.each servicesArray, ([ serviceName, service ]) ->
			throw new Error("Service #{serviceName} has no image specified.") if !service.image
			docker.getImage(service.image).inspectAsync()
			.catch ->
				dockerUtils.pullAndProtectImage(service.image, reportStatus)
	.then ->
		runComposeCommand(['up', '-d'], path, onStatus)

# Runs docker-compose down using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
exports.down = _.partial(runComposeCommand, 'down')
