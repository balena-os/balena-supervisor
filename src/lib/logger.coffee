_ = require 'lodash'
Docker = require 'docker-toolbelt'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'
{ docker } = require '../docker-utils'

LOG_PUBLISH_INTERVAL = 110

# Pubnub's message size limit is 32KB (unclear on whether it's KB or actually KiB,
# but we'll be conservative). So we limit a log message to 2 bytes less to account
# for the [ and ] in the array.
MAX_LOG_BYTE_SIZE = 30000
MAX_MESSAGE_INDEX = 9

disableLogs = false

initialised = new Promise (resolve) ->
	exports.init = (config) ->
		resolve(config)

# Queue up any calls to publish logs whilst we wait to be initialised.
publish = do ->
	publishQueue = [[]]
	messageIndex = 0
	publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE
	logsOverflow = false

	initialised.then (config) ->
		if config.offlineMode
			publish = _.noop
			publishQueue = null
			return
		pubnub = PUBNUB.init(config.pubnub)
		channel = config.channel
		doPublish = ->
			return if publishQueue[0].length is 0
			message = publishQueue.shift()
			pubnub.publish({ channel, message })
			if publishQueue.length is 0
				publishQueue = [[]]
				publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE
			messageIndex = Math.max(messageIndex - 1, 0)
			logsOverflow = false if messageIndex < MAX_MESSAGE_INDEX
		setInterval(doPublish, LOG_PUBLISH_INTERVAL)

	return (message) ->
		# Disable sending logs for bandwidth control
		return if disableLogs or (messageIndex >= MAX_MESSAGE_INDEX and publishQueueRemainingBytes <= 0)
		if _.isString(message)
			message = { m: message }

		_.defaults message,
			t: Date.now()
			m: ''
		msgLength = Buffer.byteLength(encodeURIComponent(JSON.stringify(message)), 'utf8')
		return if msgLength > MAX_LOG_BYTE_SIZE # Unlikely, but we can't allow this
		remaining = publishQueueRemainingBytes - msgLength
		if remaining >= 0
			publishQueue[messageIndex].push(message)
			publishQueueRemainingBytes = remaining
		else if messageIndex < MAX_MESSAGE_INDEX
			messageIndex += 1
			publishQueue[messageIndex] = [ message ]
			publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE - msgLength
		else if !logsOverflow
			logsOverflow = true
			messageIndex += 1
			publishQueue[messageIndex] = [ { m: 'Warning! Some logs dropped due to high load', t: Date.now(), s: 1 } ]
			publishQueueRemainingBytes = 0

# disable: A Boolean to pause the Log Publishing - Logs are lost when paused.
exports.disableLogPublishing = (disable) ->
	disableLogs = disable

exports.log = ->
	publish(arguments...)

do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	loggerLock = (containerName) ->
		_writeLock(containerName)
		.disposer (release) ->
			release()

	attached = {}
	exports.attach = (app) ->
		Promise.using loggerLock(app.containerName), ->
			if !attached[app.containerName]
				docker.getContainer(app.containerName)
				.logs({ follow: true, stdout: true, stderr: true, timestamps: true })
				.then (stream) ->
					attached[app.containerName] = true
					stream.pipe(es.split())
					.on 'data', (logLine) ->
						space = logLine.indexOf(' ')
						if space > 0
							msg = { t: logLine.substr(0, space), m: logLine.substr(space + 1) }
							publish(msg)
					.on 'error', (err) ->
						console.error('Error on container logs', err, err.stack)
						attached[app.containerName] = false
					.on 'end', ->
						attached[app.containerName] = false
