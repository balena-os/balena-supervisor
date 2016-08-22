{ docker } = require './docker-utils'
express = require 'express'
Promise = require 'bluebird'
fs = Promise.promisifyAll require 'fs'
tar = require 'tar-fs'
{ cachedResinApi, resinApi } = require './request'
knex = require './db'
_ = require 'lodash'
deviceRegister = require 'resin-register-device'
randomHexString = require './lib/random-hex-string'
utils = require './utils'
device = require './device'

getAssetsPath = (image) ->
	docker.imageRootDir(image)
	.then (rootDir) ->
		return rootDir + '/assets'

exports.router = router = express.Router()
router.use(bodyParser())

router.get '/v1/devices', (req, res) ->
# get from api or local db?


router.post '/v1/devices', (req, res) ->
	Promise.join
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		deviceRegister.generateUUID()
		randomHexString.generate()
		(apiKey, userId, uuid, logsChannel) ->
			device =
				user: userId
				application: req.body.applicationId
				uuid: uuid
				device_type: req.body.deviceType or 'edge'
				device:
				registered_at: Math.floor(Date.now() / 1000)
				logsChannel: logsChannel
			resinApi.post
				resource: 'device'
				body:

				customOptions:
					apikey: apiKey

router.get '/v1/devices/:uuid', (req, res) ->

router.put '/v1/devices/:uuid/logs', (req, res) ->

router.put '/v1/devices/:uuid/state', (req, res) ->

router.put '/v1/devices/:uuid', (req, res) ->

router.get '/v1/assets/:commit', (req, res) ->
	knex('dependentApp').select().where({ commit })
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		getAssetsPath(app.imageId)
	.then (path) ->
		dest = '/tmp/' + app.commit + '.tar'
		getTarArchive(path,dest)
	.then (archive) ->
		archive.on 'finish', ->
			res.sendFile(dest)
	.catch (err) ->
  	console.log err

getDependentAppsFromApi = (appId, apiKey) ->
	resinApi.get
		resource: 'application'
		options:
			select: [
				'id'
				'git_repository'
				'commit'
				'environment_variable'
			]
			filter:
				# ?
	.then (apps) ->
		# build imageId using git_repository and commit

getTarArchive = (path, destination) ->
  fs.lstatAsync(path)
  .then ->
    tarArchive = fs.createWriteStream(destination)
    tar.pack(path).pipe tarArchive
    return tarArchive
  .catch (err) ->
	   throw err

exports.fetchDependentApps = (appId, apiKey) ->
	Promise.join
		knex('dependentApp').select()
		getDependentAppsFromApi(appId, apiKey)
		(remoteDependentApps, localDependentApps) ->
			# Compare to see which to fetch, and which to delete
			remoteImageIds = _.map(remoteDependentApps, 'imageId')
			localImageIds = _.map(localDependentApps, 'imageId')
			toDelete = _.difference(localImageIds, remoteImageIds)
			toDownload = _.difference(remoteImageIds, localImageIds)
			Promise.map toDownload,
				#download'em
			.then ->
				Promise.map toDelete,
					#delete'em

sendUpdate = (device) ->
	knex('dependentDevice').update
	postToUpdateEndpoint(device.uuid, device.targetEnv)



exports.update = ->
	# Go through knex('dependentDevice')
	knex('dependentApp').select()
	.then (apps) ->
		dependentApps = .indexBy(apps, 'appId')
		knex('dependentDevice').select()
		.then (devices) ->
			_.each devices, (device) ->
				targetImageId = dependentApps[device.appId].imageId
				targetEnv = dependentApps[device.appId].environment
