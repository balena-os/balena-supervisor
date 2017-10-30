_ = require 'lodash'
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
	constructor: ({ @config, @eventTracker, @routers }) ->
		@server = null
		@_api = express()

		@_api.use(authenticate(@config))

		@_api.get '/ping', (req, res) ->
			res.send('OK')

		@_api.post '/v1/blink', (req, res) =>
			@eventTracker.track('Device blink')
			blink.pattern.start()
			setTimeout(blink.pattern.stop, 15000)
			res.sendStatus(200)

		@_api.post '/v1/tcp-ping', (req, res) =>
			@config.set({ connectivityCheckEnabled: true })
			res.sendStatus(204)

		@_api.delete '/v1/tcp-ping', (req, res) =>
			@config.set({ connectivityCheckEnabled: false })
			res.sendStatus(204)

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

		_.forEach @routers, (router) =>
			@_api.use(router)

	listen: (allowedInterfaces, port, apiTimeout) =>
		iptables.rejectOnAllInterfacesExcept(allowedInterfaces, port)
		.then =>
			@server = @_api.listen(port)
			@server.timeout = apiTimeout

	stop: ->
		@server.close()
