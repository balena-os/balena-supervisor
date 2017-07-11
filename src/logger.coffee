_ = require 'lodash'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'
{ checkTruthy } = require './lib/validation'

LOG_PUBLISH_INTERVAL = 110

# Pubnub's message size limit is 32KB (unclear on whether it's KB or actually KiB,
# but we'll be conservative). So we limit a log message to 2 bytes less to account
# for the [ and ] in the array.
MAX_LOG_BYTE_SIZE = 30000
MAX_MESSAGE_INDEX = 9

module.exports = class Logger
	constructor: ({ @eventTracker }) ->
		@publishQueue = [[]]
		@messageIndex = 0
		@publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE
		@logsOverflow = false
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@attached = {}
		@offlineMode = false
		@publishEnabled = false

	init: ({ pubnub, channel, offlineMode, enable }) =>
		@pubnub = PUBNUB.init(pubnub)
		@channel = channel
		@publishEnabled = checkTruthy(enable)
		@offlineMode = checkTruthy(offlineMode)
		setInterval(@doPublish, LOG_PUBLISH_INTERVAL)

	enable: (val) =>
		@publishEnabled = checkTruthy(val) ? false

	doPublish: =>
		return if @offlineMode or !@publishEnabled or @publishQueue[0].length is 0
		message = @publishQueue.shift()
		@pubnub.publish({ @channel, message })
		if @publishQueue.length is 0
			@publishQueue = [[]]
			@publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE
		@messageIndex = Math.max(@messageIndex - 1, 0)
		@logsOverflow = false if @messageIndex < MAX_MESSAGE_INDEX

	publish: (message) =>
		# Disable sending logs for bandwidth control
		return if @offlineMode or !@publishEnabled or (@messageIndex >= MAX_MESSAGE_INDEX and @publishQueueRemainingBytes <= 0)
		if _.isString(message)
			message = { m: message }

		_.defaults message,
			t: Date.now()
			m: ''
		msgLength = Buffer.byteLength(encodeURIComponent(JSON.stringify(message)), 'utf8')
		return if msgLength > MAX_LOG_BYTE_SIZE # Unlikely, but we can't allow this
		remaining = @publishQueueRemainingBytes - msgLength
		if remaining >= 0
			@publishQueue[@messageIndex].push(message)
			@publishQueueRemainingBytes = remaining
		else if @messageIndex < MAX_MESSAGE_INDEX
			@messageIndex += 1
			@publishQueue[@messageIndex] = [ message ]
			@publishQueueRemainingBytes = MAX_LOG_BYTE_SIZE - msgLength
		else if !@logsOverflow
			@logsOverflow = true
			@messageIndex += 1
			@publishQueue[@messageIndex] = [ { m: 'Warning! Some logs dropped due to high load', t: Date.now(), s: 1 } ]
			@publishQueueRemainingBytes = 0

	# log allows publishing logs through the regular way which includes a queue and has a specific channel
	# or, when a channel is specified, publishing directly to that channel
	log: (msg, opts = {}) =>
		if opts.channel?
			@pubnub.publish({ channel: opts.channel, message: msg })
		else
			@publish(msg)

	logSystemMessage: (message, obj, eventName) =>
		@log({ m: message, s: 1 })
		@eventTracker.track(eventName ? message, obj)

	lock: (containerId) =>
		@_writeLock(containerId)
		.disposer (release) ->
			release()

	attach: (docker, containerId) =>
		Promise.using @lock(containerId), =>
			if !@attached[containerId]
				docker.getContainer(containerId)
				.logs({ follow: true, stdout: true, stderr: true, timestamps: true })
				.then (stream) =>
					@attached[containerId] = true
					stream.pipe(es.split())
					.on 'data', (logLine) =>
						space = logLine.indexOf(' ')
						if space > 0
							msg = { t: logLine.substr(0, space), m: logLine.substr(space + 1) }
							@publish(msg)
					.on 'error', (err) =>
						console.error('Error on container logs', err, err.stack)
						@attached[containerId] = false
					.on 'end', =>
						@attached[containerId] = false

	logSystemEvent = (logType, app = {}, error) ->
		message = "#{logType.humanName}"
		if app.imageId?
			message += " '#{app.imageId}'"
		if error?
			# Report the message from the original cause to the user.
			errMessage = error.json
			if _.isEmpty(errMessage)
				errMessage = error.reason
			if _.isEmpty(errMessage)
				errMessage = error.message
			if _.isEmpty(errMessage)
				errMessage = 'Unknown cause'
			message += " due to '#{errMessage}'"
		logSystemMessage(message, { app, error }, logType.eventName)
		return

	logSpecialAction = (action, value, success) ->
		if success
			if !value?
				msg = "Cleared config variable #{action}"
			else
				msg = "Applied config variable #{action} = #{value}"
		else
			if !value?
				msg = "Clearing config variable #{action}"
			else
				msg = "Applying config variable #{action} = #{value}"
		logSystemMessage(msg, {}, "Apply special action #{if success then "success" else "in progress"}")