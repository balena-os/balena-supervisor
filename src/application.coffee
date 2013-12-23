Promise = require 'bluebird'
Docker = require 'dockerode'
JSONStream = require 'JSONStream'
es = require 'event-stream'
http = require 'http'

docker = Promise.promisifyAll(new Docker(socketPath: '/hostrun/docker.sock'))
# Hack dockerode to promisify internal classes' prototype
Promise.promisifyAll(docker.getImage().__proto__)

exports.start = (app) ->
	docker.getImage(app.imageId).inspectAsync().catch(->
		deferred = Promise.defer()
		options =
			method: 'POST'
			path: "/v1.8/images/create?fromImage=#{app.imageId}"
			socketPath: '/hostrun/docker.sock'

		req = http.request(options, (res) ->
			if res.statusCode isnt 200
				return deferred.reject()

			res.pipe(JSONStream.parse('error'))
				.pipe(es.mapSync((error) ->
					deferred.reject(error)
				))

			res.on('end', ->
				deferred.resolve()
			)
		)
		req.end()
		req.on('error', (error) -> deferred.reject(error))

		return deferred.promise
	).then(->
		docker.runAsync(app.imageId, ['/bin/bash', '-c', '/start web'], process.stdout, true)
	)
