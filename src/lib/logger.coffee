_ = require 'lodash'
Docker = require 'dockerode'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'

disableLogs = false

initialised = new Promise (resolve) ->
	exports.init = (config) ->
		resolve(config)

dockerPromise = initialised.then (config) ->
	docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
	# Hack dockerode to promisify internal classes' prototypes
	Promise.promisifyAll(docker.getImage().constructor.prototype)
	Promise.promisifyAll(docker.getContainer().constructor.prototype)
	return docker

# Queue up any calls to publish logs whilst we wait to be initialised.
publish = do ->
	publishQueue = []

	initialised.then (config) ->
		if config.offlineMode
			publish = _.noop
			return
		pubnub = PUBNUB.init(config.pubnub)
		channel = config.channel

		# Redefine original function
		publish = (message) ->
			# Disable sending logs for bandwidth control
			return if disableLogs
			if _.isString(message)
				message = { message }

			_.defaults message,
				timestamp: Date.now()
				# Stop pubnub logging loads of "Missing Message" errors, as they are quite distracting
				message: ' '

			pubnub.publish({ channel, message })

		# Replay queue now that we have initialised the publish function
		publish(args...) for args in publishQueue

	return -> publishQueue.push(arguments)

# disable: A Boolean to pause the Log Publishing - Logs are lost when paused.
exports.disableLogPublishing = (disable) ->
	disableLogs = disable

exports.log = ->
	publish(arguments...)

do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	loggerLock = (containerId) ->
		_writeLock(containerId)
		.disposer (release) ->
			release()

	attached = {}
	exports.attach = (app) ->
		Promise.using loggerLock(app.containerId), ->
			if !attached[app.containerId]
				dockerPromise.then (docker) ->
					docker.getContainer(app.containerId)
					.attachAsync({ stream: true, stdout: true, stderr: true, tty: true })
					.then (stream) ->
						attached[app.containerId] = true
						stream.pipe(es.split())
						.on('data', publish)
						.on 'error', ->
							attached[app.containerId] = false
						.on 'end', ->
							attached[app.containerId] = false
