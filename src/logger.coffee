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
		Promise.try =>
			@pubnub = PUBNUB.init(pubnub)
			@channel = channel
			@publishEnabled = checkTruthy(enable)
			@offlineMode = checkTruthy(offlineMode)
			setInterval(@doPublish, LOG_PUBLISH_INTERVAL)

	enable: (val) =>
		@publishEnabled = checkTruthy(val) ? true

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
		messageObj = { m: message, s: 1 }
		if obj?.serviceId?
			messageObj.c = obj.serviceId
		@log(messageObj)
		@eventTracker.track(eventName ? message, obj)

	lock: (containerId) =>
		@_writeLock(containerId)
		.disposer (release) ->
			release()

	attach: (docker, containerId, serviceId) =>
		Promise.using @lock(containerId), =>
			if !@attached[containerId]
				docker.getContainer(containerId)
				.logs({ follow: true, stdout: true, stderr: true, timestamps: true })
				.then (stream) =>
					@attached[containerId] = true
					stream
					.on 'error', (err) =>
						console.error('Error on container logs', err, err.stack)
						@attached[containerId] = false
					.pipe(es.split())
					.on 'data', (logLine) =>
						space = logLine.indexOf(' ')
						if space > 0
							msg = { t: logLine.substr(0, space), m: logLine.substr(space + 1), c: serviceId }
							@publish(msg)
					.on 'error', (err) =>
						console.error('Error on container logs', err, err.stack)
						@attached[containerId] = false
					.on 'end', =>
						@attached[containerId] = false

	objectNameForLogs: (obj = {}) ->
		if obj.service?.serviceName? and obj.service?.image?
			return "#{obj.service.serviceName} #{obj.service.image}"
		else if obj.image?
			return obj.image.name
		else if obj.network?.name?
			return obj.network.name
		else if obj.volume?.name?
			return obj.volume.name
		else
			return null

	logSystemEvent: (logType, obj = {}) ->
		message = "#{logType.humanName}"
		objName = @objectNameForLogs(obj)
		message += " '#{objName}'" if objName?
		if obj.error?
			# Report the message from the original cause to the user.
			errMessage = obj.error.message
			if _.isEmpty(errMessage)
				errMessage = obj.error.json
			if _.isEmpty(errMessage)
				errMessage = obj.error.reason
			if _.isEmpty(errMessage)
				errMessage = 'Unknown cause'
			message += " due to '#{errMessage}'"
		@logSystemMessage(message, obj, logType.eventName)
		return

	logConfigChange: (config, { success = false, err = null } = {}) ->
		obj = { config }
		if success
			msg = "Applied configuration change #{JSON.stringify(config)}"
			eventName = 'Apply config change success'
		else if err?
			msg = "Error applying configuration change: #{err}"
			eventName = 'Apply config change error'
			obj.error = err
		else
			msg = "Applying configuration change #{JSON.stringify(config)}"
			eventName = 'Apply config change in progress'
		@logSystemMessage(msg, obj, eventName)
