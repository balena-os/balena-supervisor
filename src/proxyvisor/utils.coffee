Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
path = require 'path'
mkdirp = Promise.promisify(require('mkdirp'))
execAsync = Promise.promisify(require('child_process').exec)

self = module.exports =

	isDefined: _.negate(_.isUndefined)
	validStringOrUndefined: (s) ->
		_.isUndefined(s) or !_.isEmpty(s)
	validObjectOrUndefined: (o) ->
		_.isUndefined(o) or _.isObject(o)
	validBooleanOrUndefined: (b) ->
		_.isUndefined(b) or _.isBoolean(b)
	validNumberOrUndefined: (i) ->
		_.isUndefined(i) or !_.isNaN(parseInt(i))
	validDateOrUndefined: (d) ->
		_.isUndefined(d) or _.isDate(new Date(d))

	parseDeviceFields: (device) ->
		device.appId = parseInt(device.appId)
		device.environment = JSON.parse(device.environment ? '{}')
		device.targetEnvironment = JSON.parse(device.targetEnvironment ? '{}')
		device.config = JSON.parse(device.config ? '{}')
		device.targetConfig = JSON.parse(device.targetConfig ? '{}')
		return _.omit(device, 'deviceId', 'markedForDeletion', 'logs_channel')

	parseApplicationFields: (application) ->
		application.appId = parseInt(application.appId)
		application.parentApp = parseInt(application.parentApp)
		application.environment = JSON.parse(application.environment ? '{}')
		application.config = JSON.parse(application.config ? '{}')
		return _.omit(application, 'id', 'releaseId', 'image')

	tarDirectory: (appId) ->
		return "/data/dependent-assets/#{appId}"

	tarFilename: (appId, commit) ->
		return "#{appId}-#{commit}.tar"

	tarPath: (appId, commit) ->
		return "#{self.tarDirectory(appId)}/#{self.tarFilename(appId, commit)}"

	getTarArchive: (source, destination) ->
		fs.lstatAsync(destination)
		.catch ->
			mkdirp(path.dirname(destination))
			.then ->
				execAsync("tar -cvf '#{destination}' *", cwd: source)

	cleanupTars: (appId, commit) ->
		if commit?
			fileToKeep = self.tarFilename(appId, commit)
		else
			fileToKeep = null
		dir = self.tarDirectory(appId)
		fs.readdirAsync(dir)
		.catchReturn([])
		.then (files) ->
			if fileToKeep?
				files = _.filter files, (file) ->
					return file isnt fileToKeep
			Promise.map files, (file) ->
				if !fileToKeep? or (file isnt fileToKeep)
					fs.unlinkAsync(path.join(dir, file))

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
