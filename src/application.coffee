_ = require 'lodash'
es = require 'event-stream'
url = require 'url'
http = require 'http'
knex = require './db'
path = require 'path'
Docker = require 'dockerode'
Promise = require 'bluebird'
request = Promise.promisify require 'request'
JSONStream = require 'JSONStream'
PlatformAPI = require 'resin-platform-api/request'

REGISTRY_ENDPOINT = 'registry.resin.io'
DOCKER_SOCKET = '/run/docker.sock'
PLATFORM_ENDPOINT = url.resolve(process.env.API_ENDPOINT, '/ewa/')
resinAPI = new PlatformAPI(PLATFORM_ENDPOINT)

docker = Promise.promisifyAll(new Docker(socketPath: DOCKER_SOCKET))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

exports.kill = kill = (app) ->
	docker.listContainersAsync(all: 1)
	.then (containers) ->
		Promise.all(
			containers
			.filter (container) -> container.Image is "#{app.imageId}:latest"
			.map (container) -> docker.getContainer(container.Id)
			.map (container) ->
				console.log("Stopping and deleting container:", container)
				container.stopAsync()
				.then ->
					container.removeAsync()
		)

exports.start = start = (app) ->
	docker.getImage(app).inspectAsync()
	.catch (error) ->
		console.log("Pulling image:", app.imageId)
		deferred = Promise.defer()
		options =
			method: 'POST'
			path: "/v1.8/images/create?fromImage=#{app.imageId}"
			socketPath: DOCKER_SOCKET

		req = http.request options, (res) ->
			if res.headers['content-type'] is 'application/json'
				res.pipe(JSONStream.parse('error'))
				.pipe es.mapSync (error) ->
					deferred.reject(error)
			else
				res.pipe es.wait (error, text) -> deferred.reject(text)

			res.on 'end', ->
				if res.statusCode is 200
					deferred.resolve()
				else
					deferred.reject(res.statusCode)

		req.end()
		req.on 'error', (error) -> deferred.reject(error)

		return deferred.promise
	.then ->
		console.log("Creating container:", app.imageId)
		docker.createContainerAsync(
			Image: app.imageId
			Cmd: ['/bin/bash', '-c', '/start web']
			Volumes:
				'/dev': {}
			Env: env
		)
	.then (container) ->
		console.log('Starting container:', app.imageId)
		container.startAsync(
			Privileged: true
			Binds: ['/dev:/dev']
		)
	.tap ->
		console.log('Started container:', app.imageId)

exports.restart = restart = (app) ->
	kill(app)
	.then ->
		start(app)

exports.update = ->
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
		knex('app').select()
	])
	.then ([[apiKey], [uuid], apps]) ->
		apiKey = apiKey.value
		uuid = uuid.value
		resinAPI.get(
			resource: 'application'
			options:
				expand: 'environment_variable'
				filter:
					'device/uuid': uuid
			customOptions:
				apikey: apiKey
		)
		.then (remoteApps) ->
			console.log("Remote apps")
			remoteApps = _.filter(remoteApps, 'commit')
			remoteApps = _.map remoteApps, (app) ->
				env = {}
				if app.environment_variable?
					for envVar in app.environment_variable
						env[envVar.name] = envVar.value
				return {
					imageId: "#{REGISTRY_ENDPOINT}/#{path.basename(app.git_repository, '.git')}/#{app.commit}"
					env: env
				}

			remoteApps = _.indexBy(remoteApps, 'imageId')
			remoteImages = _.keys(remoteApps)
			console.log(remoteImages)

			console.log("Local apps")
			apps = _.map(apps, (app) -> _.pick(app, ['imageId', 'env']))
			apps = _.indexBy(apps, 'imageId')
			localImages = _.keys(apps)
			console.log(localImages)

			console.log("Apps to be removed")
			toBeRemoved = _.difference(localImages, remoteImages)
			console.log(toBeRemoved)

			console.log("Apps to be installed")
			toBeInstalled = _.difference(remoteImages, localImages)
			console.log(toBeInstalled)

			console.log("Apps to be updated")
			toBeUpdated = _.intersection(remoteImages, localImages)
			toBeUpdated = _.filter toBeUpdated, (imageId) ->
				return _.isEqual(remoteApps[imageId], apps[imageId])
			console.log(toBeUpdated)

			# Install the apps and add each to the db as they succeed
			promises = toBeInstalled.map (imageId) ->
				app = remoteApps[imageId]
				start(app)
				.then -> 
					knex('app').insert(app)
			# And restart updated apps and update db as they succeed
			promises = promises.concat toBeUpdated.map (imageId) ->
				app = remoteApps[imageId]
				restart(app)
				.then -> 
					knex('app').update(app).where(imageId: app.imageId)
			# And delete all the ones to remove in one go
			promises.push(
				Promise.all(toBeRemoved.map(kill))
				.then ->
					knex('app').whereIn('imageId', toBeRemoved).delete()
			)
			Promise.all(promises)
