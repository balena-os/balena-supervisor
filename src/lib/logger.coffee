_ = require 'lodash'
Docker = require 'dockerode'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'

LOG_PUBLISH_INTERVAL = 110

# Pubnub's message size limit is 32KB (unclear on whether it's KB or actually KiB,
# but we'll be conservative). So we limit a log message to 2 bytes less to account
# for the [ and ] in the array.
MAX_LOG_BYTE_SIZE = 31998

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
	publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE

	initialised.then (config) ->
		if config.offlineMode
			publish = _.noop
			publishQueue = null
			return
		pubnub = PUBNUB.init(config.pubnub)
		channel = config.channel
		doPublish = ->
			return if publishQueue.length is 0
			pubnub.publish({ channel, message: publishQueue })
			publishQueue = []
			publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE
		setInterval(doPublish, LOG_PUBLISH_INTERVAL)

	return (message) ->
		# Disable sending logs for bandwidth control
		return if disableLogs or publishQueueRemainingBytes <= 0
		if _.isString(message)
			message = { m: message }

		_.defaults message,
			t: Date.now()
			m: ''
		msgLength = Buffer.byteLength(JSON.stringify(message), 'utf8')
		publishQueueRemainingBytes -= msgLength
		publishQueue.push(message) if publishQueueRemainingBytes >= 0


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
