_ = require 'lodash'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'
{ checkTruthy } = require './lib/validation'

class NativeLoggerBackend
	constructor: ->
		@logPublishInterval = 1000
		@maxLogLinesPerBatch = 10
		@maxQueueSize = 100
		@maxLineLength = 300
		@publishQueue = []
		@intervalHandle = null
		@publishEnabled = false
		@offlineMode = false
		@shouldStop = false

	publishLoop: =>
		startTime = process.hrtime()
		Promise.try =>
			return if @offlineMode or !@publishEnabled or @publishQueue.length is 0
			currentBatch = @publishQueue.splice(0, @maxLogLinesPerBatch)
			# Silently ignore errors sending logs (just like with pubnub)
			@apiBinder.logBatch(currentBatch)
		.catchReturn()
		.then =>
			elapsedTime = process.hrtime(startTime)
			elapsedTimeMs = elapsedTime[0] * 1000 + elapsedTime[1] / 1e6
			nextDelay = Math.max(@logPublishInterval - elapsedTimeMs, 0)
			Promise.delay(nextDelay)
		.then =>
			if !@shouldStop
				@publishLoop()

	_truncateToMaxLength: (message) =>
		if message.message.length > @maxLineLength
			message = _.clone(message)
			message.message = _.truncate(message.message, { length: @maxLineLength, omission: '[...]' })
		return message

	logDependent: (msg, { uuid }) =>
		msg = @_truncateToMaxLength(msg)
		@apiBinder.logDependent(uuid, msg)

	log: (message) =>
		return if @offlineMode or !@publishEnabled or @publishQueue.length >= @maxQueueSize
		if _.isString(message)
			message = { message: message }

		message = _.defaults({}, message, {
			timestamp: Date.now()
			message: ''
		})

		message = @_truncateToMaxLength(message)

		if @publishQueue.length < @maxQueueSize - 1
			@publishQueue.push(_.pick(message, [ 'message', 'timestamp', 'isSystem', 'isStderr', 'imageId' ]))
		else
			@publishQueue.push({
				message: 'Warning! Some logs dropped due to high load'
				timestamp: Date.now()
				isSystem: true
				isStderr: true
			})

	start: (opts) =>
		console.log('Starting native logger')
		@apiBinder = opts.apiBinder
		@publishEnabled = checkTruthy(opts.enable)
		@offlineMode = checkTruthy(opts.offlineMode)
		@publishLoop()
		return null

	stop: =>
		console.log('Stopping native logger')
		@shouldStop = true

class PubnubLoggerBackend
	constructor: ->
		@publishQueue = [[]]
		@messageIndex = 0
		@maxMessageIndex = 9
		# Pubnub's message size limit is 32KB (unclear on whether it's KB or actually KiB,
		# but we'll be conservative). So we limit a log message to 2 bytes less to account
		# for the [ and ] in the array.
		@maxLogByteSize = 30000
		@publishQueueRemainingBytes = @maxLogByteSize
		@logsOverflow = false
		@logPublishInterval = 110

	doPublish: =>
		return if @offlineMode or !@publishEnabled or @publishQueue[0].length is 0
		message = @publishQueue.shift()
		@pubnub.publish({ @channel, message })
		if @publishQueue.length is 0
			@publishQueue = [[]]
			@publishQueueRemainingBytes = @maxLogByteSize
		@messageIndex = Math.max(@messageIndex - 1, 0)
		@logsOverflow = false if @messageIndex < @maxMessageIndex

	logDependent: (message, { channel }) ->
		@pubnub.publish({ channel, message })

	log: (msg) =>
		return if @offlineMode or !@publishEnabled or (@messageIndex >= @maxMessageIndex and @publishQueueRemainingBytes <= 0)
		if _.isString(message)
			message = { m: msg }
		else
			message = {
				m: msg.message
				t: msg.timestamp
			}
			if msg.isSystem
				message.s = 1
			if msg.serviceId?
				message.c = msg.serviceId
			if msg.isStderr
				message.e = 1

		_.defaults message,
			t: Date.now()
			m: ''

		msgLength = Buffer.byteLength(encodeURIComponent(JSON.stringify(message)), 'utf8')
		return if msgLength > @maxLogByteSize # Unlikely, but we can't allow this
		remaining = @publishQueueRemainingBytes - msgLength
		if remaining >= 0
			@publishQueue[@messageIndex].push(message)
			@publishQueueRemainingBytes = remaining
		else if @messageIndex < @maxMessageIndex
			@messageIndex += 1
			@publishQueue[@messageIndex] = [ message ]
			@publishQueueRemainingBytes = @maxLogByteSize - msgLength
		else if !@logsOverflow
			@logsOverflow = true
			@messageIndex += 1
			@publishQueue[@messageIndex] = [ { m: 'Warning! Some logs dropped due to high load', t: Date.now(), s: 1 } ]
			@publishQueueRemainingBytes = 0

	start: (opts) =>
		console.log('Starting pubnub logger')
		@pubnub = PUBNUB.init(opts.pubnub)
		@channel = opts.channel
		@publishEnabled = checkTruthy(opts.enable)
		@offlineMode = checkTruthy(opts.offlineMode)
		@intervalHandle = setInterval(@doPublish, @logPublishInterval)

	stop: =>
		console.log('Stopping pubnub logger')
		clearInterval(@intervalHandle)

module.exports = class Logger
	constructor: ({ @eventTracker }) ->
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@attached = { stdout: {}, stderr: {} }
		@opts = {}
		@backend = null

	init: (opts) =>
		Promise.try =>
			@opts = opts
			@_startBackend()

	stop: =>
		if @backend?
			@backend.stop()

	_startBackend: =>
		if checkTruthy(@opts.nativeLogger)
			@backend = new NativeLoggerBackend()
		else
			@backend = new PubnubLoggerBackend()
		@backend.start(@opts)

	switchBackend: (nativeLogger) =>
		if checkTruthy(nativeLogger) != checkTruthy(@opts.nativeLogger)
			@opts.nativeLogger = nativeLogger
			@backend.stop()
			@_startBackend()

	enable: (val) =>
		@opts.enable = val
		@backend.publishEnabled = checkTruthy(val) ? true

	logDependent: (msg, device) =>
		@backend.logDependent(msg, device)

	log: (msg) =>
		@backend.log(msg)

	logSystemMessage: (msg, obj, eventName) =>
		messageObj = { message: msg, isSystem: true }
		if obj?.error?
			messageObj.isStderr = true
		@log(messageObj)
		@eventTracker.track(eventName ? msg, obj)

	lock: (containerId) =>
		@_writeLock(containerId)
		.disposer (release) ->
			release()

	_attachStream: (docker, stdoutOrStderr, containerId, { serviceId, imageId }) =>
		Promise.try =>
			if stdoutOrStderr not in [ 'stdout', 'stderr' ]
				throw new Error("Invalid log selection #{stdoutOrStderr}")
			if !@attached[stdoutOrStderr][containerId]
				logsOpts = { follow: true, stdout: stdoutOrStderr == 'stdout', stderr: stdoutOrStderr == 'stderr', timestamps: true }
				docker.getContainer(containerId)
				.logs(logsOpts)
				.then (stream) =>
					@attached[stdoutOrStderr][containerId] = true
					stream
					.on 'error', (err) =>
						console.error('Error on container logs', err, err.stack)
						@attached[stdoutOrStderr][containerId] = false
					.pipe(es.split())
					.on 'data', (logLine) =>
						space = logLine.indexOf(' ')
						if space > 0
							msg = { timestamp: logLine.substr(0, space), message: logLine.substr(space + 1), serviceId, imageId }
							if stdoutOrStderr == 'stderr'
								msg.isStderr = true
							@log(msg)
					.on 'error', (err) =>
						console.error('Error on container logs', err, err.stack)
						@attached[stdoutOrStderr][containerId] = false
					.on 'end', =>
						@attached[stdoutOrStderr][containerId] = false

	attach: (docker, containerId, serviceInfo) =>
		Promise.using @lock(containerId), =>
			@_attachStream(docker, 'stdout', containerId, serviceInfo)
		.then =>
			@_attachStream(docker, 'stderr', containerId, serviceInfo)

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
				errMessage = 'Unknown cause'
				console.log('Warning: invalid error message', obj.error)
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
