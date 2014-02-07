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

docker = Promise.promisifyAll(new Docker(socketPath: '/hostrun/docker.sock'))
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(docker.getImage().__proto__)
Promise.promisifyAll(docker.getContainer().__proto__)

exports.kill = kill = (app) ->
	docker.listContainersAsync(all: 1).then((containers) ->
		Promise.all(
			containers
				.filter((container) ->
					return container.Image is "#{app}:latest"
				)
				.map((container) -> docker.getContainer(container.Id))
				.map((container) ->
					console.log("Stopping and deleting container:", container)
					container.stopAsync().then(->
						container.removeAsync()
					)
				)
		)
	)

exports.start = start = (app) ->
	docker.getImage(app).inspectAsync().catch((error) ->
		console.log("Pulling image:", app)
		deferred = Promise.defer()
		options =
			method: 'POST'
			path: "/v1.8/images/create?fromImage=#{app}"
			socketPath: '/hostrun/docker.sock'

		req = http.request(options, (res) ->
			if res.headers['content-type'] is 'application/json'
				res.pipe(JSONStream.parse('error'))
					.pipe(es.mapSync((error) ->
						deferred.reject(error)
					))
			else
				res.pipe(es.wait((error, text) -> deferred.reject(text)))

			res.on('end', ->
				if res.statusCode is 200
					deferred.resolve()
				else
					deferred.reject(res.statusCode)
			)
		)
		req.end()
		req.on('error', (error) -> deferred.reject(error))

		return deferred.promise
	).then(->
		console.log("Creating container:", app)
		docker.createContainerAsync(
			Image: app
			Cmd: ['/bin/bash', '-c', '/start web']
			Volumes:
				'/dev': {}
		)
	).then((container) ->
		container.startAsync(
			Privileged: true
			Binds: ['/dev:/dev']
		)
	)

exports.restart = restart = (app) ->
	kill(app).then(->
		start(app)
	)

exports.update = ->
	Promise.all([
		knex('config').select('value').where(key: 'apiKey')
		knex('config').select('value').where(key: 'uuid')
		knex('app').select()
	]).then(([[apiKey], [uuid], apps]) ->
		apiKey = apiKey.value
		uuid = uuid.value
		request(
			method: 'GET'
			url: url.resolve(process.env.API_ENDPOINT, "/ewa/application?$filter=device/uuid eq '#{uuid}'&apikey=#{apiKey}")
			json: true
		).spread((request, body) ->
			console.log("Remote apps")
			remoteApps = ("registry.resin.io/#{path.basename(app.git_repository, '.git')}/#{app.commit}" for app in body.d when app.commit)
			console.log(remoteApps)

			console.log("Local apps")
			localApps = (app.imageId for app in apps)
			console.log(localApps)

			console.log("Apps to be removed")
			toBeRemoved = _.difference(localApps, remoteApps)
			console.log(toBeRemoved)

			console.log("Apps to be installed")
			toBeInstalled = _.difference(remoteApps, localApps)
			console.log(toBeInstalled)

			Promise.all(toBeRemoved.map(kill)).then(->
				Promise.all(toBeInstalled.map(start))
			).then(->
				knex('app').whereIn('imageId', toBeRemoved).delete().then(->
					knex('app').insert(({imageId: app} for app in toBeInstalled))
				)
			)
		)

	)
