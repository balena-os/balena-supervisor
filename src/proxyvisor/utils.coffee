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
		return _.omit(device, 'id', 'deviceId', 'logs_channel')

	parseApplicationFields: (application) ->
		application.appId = parseInt(application.appId)
		application.parentApp = parseInt(application.parentApp)
		return _.omit(application, 'id', 'image', 'releaseId')

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

	imageAvailable: (image, available) ->
		_.some(available, (availableImage) -> availableImage.name == image)

	compareDevices: (currentDevices, targetDevices, appId) ->
		currentDeviceTargets = _.map currentDevices, (dev) ->
			return null if dev.markedForDeletion
			devTarget = _.clone(dev)
			delete devTarget.markedForDeletion
			devTarget.apps = {}
			devTarget.apps[appId] = {
				commit: dev.apps[appId].targetCommit
				environment: dev.apps[appId].targetEnvironment
				config: dev.apps[appId].targetConfig
			}
			return devTarget
		currentDeviceTargets = _.filter(currentDeviceTargets, (dev) -> !_.isNull(dev))
		return !_.isEmpty(_.xorWith(currentDeviceTargets, targetDevices, _.isEqual))

	imageForDependentApp: (app) ->
		return {
			name: app.image
			imageId: app.imageId
			appId: app.appId
			dependent: true
		}

