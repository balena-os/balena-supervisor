Promise = require 'bluebird'
express = require 'express'
bufferEq = require 'buffer-equal-constant-time'
blink = require './lib/blink'
iptables = require './lib/iptables'
{ checkTruthy } = require './lib/validation'

authenticate = (config) ->
	return (req, res, next) ->
		queryKey = req.query.apikey
		header = req.get('Authorization') ? ''
		match = header.match(/^ApiKey (\w+)$/)
		headerKey = match?[1]
		config.getMany([ 'apiSecret', 'localMode' ])
		.then (conf) ->
			if queryKey? && bufferEq(new Buffer(queryKey), new Buffer(conf.apiSecret))
				next()
			else if headerKey? && bufferEq(new Buffer(headerKey), new Buffer(conf.apiSecret))
				next()
			else if checkTruthy(conf.localMode)
				next()
			else
				res.sendStatus(401)
		.catch (err) ->
			# This should never happen...
			res.status(503).send('Invalid API key in supervisor')

module.exports = class SupervisorAPI
	constructor: ({ @config, @eventTracker, @routers, @healthchecks }) ->
		@server = null
		@_api = express()
		@_api.disable('x-powered-by')

		@_api.get '/v1/healthy', (req, res) =>
			Promise.map @healthchecks, (fn) ->
				fn()
				.then (healthy) ->
					if !healthy
						throw new Error('Unhealthy')
			.then ->
				res.sendStatus(200)
			.catch ->
				res.sendStatus(500)

		@_api.use(authenticate(@config))

		@_api.get '/ping', (req, res) ->
			res.send('OK')

		@_api.post '/v1/blink', (req, res) =>
			@eventTracker.track('Device blink')
			blink.pattern.start()
			setTimeout(blink.pattern.stop, 15000)
			res.sendStatus(200)

		# Expires the supervisor's API key and generates a new one.
		# It also communicates the new key to the Resin API.
		@_api.post '/v1/regenerate-api-key', (req, res) =>
			@config.newUniqueKey()
			.then (secret) =>
				@config.set(apiSecret: secret)
				.then ->
					res.status(200).send(secret)
			.catch (err) ->
				res.status(503).send(err?.message or err or 'Unknown error')


		for router in @routers
			@_api.use(router)

	listen: (allowedInterfaces, port, apiTimeout) =>
		@config.get('localMode').then (localMode) =>
			@applyListeningRules(checkTruthy(localMode), port, allowedInterfaces)
		.then =>
			# Monitor the switching of local mode, and change which interfaces will
			# be listented to based on that
			@config.on 'change', (changedConfig) =>
				if changedConfig.localMode?
					@applyListeningRules(changedConfig.localMode, port, allowedInterfaces)
		.then =>
			@server = @_api.listen(port)
			@server.timeout = apiTimeout

	applyListeningRules: (allInterfaces, port, allowedInterfaces) =>
		Promise.try ->
			if checkTruthy(allInterfaces)
				iptables.removeRejections(port).then ->
					console.log('Supervisor API listening on all interfaces')
			else
				iptables.rejectOnAllInterfacesExcept(allowedInterfaces, port).then ->
					console.log('Supervisor API listening on allowed interfaces only')
		.catch (e) =>
			# If there's an error, stop the supervisor api from answering any endpoints,
			# and this will eventually be restarted by the healthcheck
			console.log('Error on switching supervisor API listening rules - stopping API.')
			console.log('  ', e)
			if @server?
				@stop()

	stop: ->
		@server.close()
