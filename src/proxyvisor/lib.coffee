Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
path = require 'path'
mkdirp = Promise.promisify(require('mkdirp'))
execAsync = Promise.promisify(require('child_process').exec)

module.exports =

	isDefined: _.negate(_.isUndefined)

	parseDeviceFields: (device) ->
		device.id = parseInt(device.deviceId)
		device.appId = parseInt(device.appId)
		device.config = JSON.parse(device.config ? '{}')
		device.environment = JSON.parse(device.environment ? '{}')
		device.targetConfig = JSON.parse(device.targetConfig ? '{}')
		device.targetEnvironment = JSON.parse(device.targetEnvironment ? '{}')
		return _.omit(device, 'markedForDeletion', 'logs_channel')

	# TODO move to lib/validation
	validStringOrUndefined: (s) ->
		_.isUndefined(s) or !_.isEmpty(s)
	validObjectOrUndefined: (o) ->
		_.isUndefined(o) or _.isObject(o)

	tarDirectory: (appId) ->
		return "/data/dependent-assets/#{appId}"

	tarFilename: (appId, commit) ->
		return "#{appId}-#{commit}.tar"

	tarPath: (appId, commit) ->
		return "#{@tarDirectory(appId)}/#{@tarFilename(appId, commit)}"

	getTarArchive: (source, destination) ->
		fs.lstatAsync(destination)
		.catch ->
			mkdirp(path.dirname(destination))
			.then ->
				execAsync("tar -cvf '#{destination}' *", cwd: source)

	cleanupTars: (appId, commit) ->
		if commit?
			fileToKeep = @tarPath(appId, commit)
		else
			fileToKeep = null
		fs.readdirAsync(@tarDirectory(appId))
		.catchReturn([])
		.then (files) ->
			if fileToKeep?
				files = _.filter files, (file) ->
					return file isnt fileToKeep
			Promise.map files, (file) ->
				if !fileToKeep? or (file isnt fileToKeep)
					fs.unlinkAsync(file)

	formatTargetAsState: (device) ->
		return {
			appId: parseInt(device.appId)
			commit: device.targetCommit
			environment: device.targetEnvironment
			config: device.targetConfig
		}

	formatCurrentAsState: (device) ->
		return {
			appId: parseInt(device.appId)
			commit: device.commit
			environment: device.environment
			config: device.config
		}
