Promise = require 'bluebird'
YAML = require 'yamljs'
_ = require 'lodash'
dockerUtils = require './docker-utils'
{ docker } = dockerUtils
fs = Promise.promisifyAll(require('fs'))
{ spawn, execAsync } = Promise.promisifyAll(require('child_process'))
mkdirp = Promise.promisify(require('mkdirp'))
path = require 'path'
utils = require './utils'

composePathSrc = (appId) ->
	return "/mnt/root#{config.dataPath}/#{appId}/docker-compose.yml"

composePathDst = (appId) ->
	return "/mnt/root#{config.dataPath}/resin-supervisor/compose/#{appId}/docker-compose.yml"

composeDataPath = (appId, serviceName) ->
	return "compose/#{appId}/#{serviceName}"

runComposeCommand = (composeArgs, appId, reportStatus) ->
	new Promise (resolve, reject) ->
		child = spawn('docker-compose', ['-f', composePathDst(appId)].concat(composeArgs), stdio: 'pipe')
		.on 'error', reject
		.on 'exit', (code) ->
			return reject(new Error("docker-compose exited with code #{code}")) if code isnt 0
			resolve()
		child.stdout.on 'data', (data) ->
			reportStatus(status: '' + data)
		child.stderr.on 'data', (data) ->
			reportStatus(status: '' + data)

writeComposeFile = (composeSpec, dstPath) ->
	mkdirp(path.dirname(dstPath))
	.then ->
		YAML.stringify(composeSpec)
	.then (yml) ->
		fs.writeFileAsync(dstPath, yml)
	.then ->
		execAsync('sync')

validateServiceOptions = (service) ->
	Promise.try ->
		options = _.keys(service)
		_.each options, (option) ->
			throw new Error("Using #{option} is not allowed.") if !_.includes(utils.validComposeOptions, option)

# Runs docker-compose up using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
# Copies the compose file from srcPath to dstPath adding default volumes
exports.up = (appId, onStatus) ->
	onStatus ?= console.log.bind(console)
	reportStatus = (status) ->
		try onStatus(status)
	fs.readFileAsync(composePathSrc(appId))
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
				validateServiceOptions(service)
			.then ->
				services[serviceName].volumes = utils.defaultBinds(composeDataPath(appId, serviceName))
		.then ->
			writeComposeFile(composeSpec, dstPath)
	.then ->
		runComposeCommand(['up', '-d'], appId, reportStatus)
	.catch (err) ->
		msg = err?.message or err
		reportStatus(error: msg)
		throw err

# Runs docker-compose down using the compose YAML at "path".
# Reports status and errors in JSON to the onStatus function.
exports.down = (appId, onStatus)
	onStatus ?= console.log.bind(console)
	reportStatus = (status) ->
		try onStatus(status)
	runComposeCommand([ 'down' ], appId, reportStatus)
	.catch (err) ->
		msg = err?.message or err
		reportStatus(error: msg)
		throw err
