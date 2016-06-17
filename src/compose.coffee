Promise = require 'bluebird'
YAML = require 'yamljs'
_ = require 'lodash'
dockerUtils = require './docker-utils'
{ docker } = dockerUtils
fs = Promise.promisifyAll 'fs'
spawn = require('child-process').spawn

# Runs docker-compose up using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
exports.up = (path, onStatus) ->
	onStatus = console.log if !onStatus?
	reportStatus = (status) ->
		status = JSON.stringify(status) if _.isObject(status)
		onStatus(status)
	fs.readFileAsync(path)
	.then(YAML.parse)
	.then (composeSpec) ->
		if composeSpec.version? && composeSpec.version == '2'
			services = composeSpec.services
		else
			services = composeSpec
		Promise.each services, (service, serviceName) ->
			throw new Error("Service #{serviceName} has no image specified.") if !service.image
			docker.getImage(service.image).inspectAsync()
			.catch ->
				dockerUtils.pullImage(service.image, reportStatus)
	.then ->
		new Promise (resolve, reject) ->
			child = spawn('docker-compose', ['-f', path, 'up', '-d'], stdio: 'pipe')
			.on 'error', reject
			.on 'exit', (code) ->
				return reject(new Error("docker-compose exited with code #{code}"))
				resolve()
			child.stdout.on 'data', (data) ->
				reportStatus(status: '' + data)
			child.stderr.on 'data', (data) ->
				reportStatus(error: '' + data)
	.catch (err) ->
		msg = err?.message or err
		reportStatus(error: msg)
		throw err

# Runs docker-compose down using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
exports.down = (path, onStatus) ->
	onStatus = console.log if !onStatus?
	reportStatus = (status) ->
		status = JSON.stringify(status) if _.isObject(status)
		onStatus(status)
	new Promise (resolve, reject) ->
		child = spawn('docker-compose', ['-f', path, 'down'], stdio: 'pipe')
		.on 'error', reject
		.on 'exit', (code) ->
			return reject(new Error("docker-compose exited with code #{code}"))
			resolve()
		child.stdout.on 'data', (data) ->
			reportStatus(status: '' + data)
		child.stderr.on 'data', (data) ->
			reportStatus(error: '' + data)
	.catch (err) ->
		msg = err?.message or err
		reportStatus(error: msg)
		throw err
