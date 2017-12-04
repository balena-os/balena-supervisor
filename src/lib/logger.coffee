_ = require 'lodash'
Docker = require 'docker-toolbelt'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'
{ docker } = require '../docker-utils'
{ resinApi } = require '../request'
{ checkTruthy } = require './validation'
zlib = Promise.promisifyAll(require('zlib'))

do ->
	_loggerConfig = null
	_logger = null

	exports.init = (config) ->
		_loggerConfig = config
		_loggerConfig.useNativeLogger ?= true
		_loggerConfig.enable ?= true
		startLogger()

	startLogger = ->
		if _loggerConfig.useNativeLogger
			_logger = new NativeLogger()
		else
			_logger = new PubnubLogger()
		logger.start()

	# Callback function to enable/disable logs
	exports.enable = (val) ->
		logEnabled = checkTruthy(val) ? true
		_logger.enable(logEnabled)
		console.log('Logs enabled: ' + val)

	exports.switchNativeOrPubnub = (val) ->
		useNative = checkTruthy(val) ? true
		if _loggerConfig.useNativeLogger != useNative
			_loggerConfig.useNativeLogger = useNative
			_logger.stop()
			startLogger()

	class BaseLogger
		constructor: ->
			@isEnabled = true
			@intervalHandle = null

		enable: (val) =>
			@isEnabled = val

		stop: =>
			if @intervalHandle?
				clearInterval(@intervalHandle)
				@publishQueue = null

		start: =>
			if _loggerConfig.offlineMode
				return
			@intervalHandle = setInterval(@doPublish, @logPublishInterval)

		doPublish: ->
			console.error('doPublish not implemented')

		publish: ->
			console.error('publish not implemented')

	class PubnubLogger
		constructor: ->
			@logPublishInterval = 110
			# Pubnub's message size limit is 32KB (unclear on whether it's KB or actually KiB,
			# but we'll be conservative). So we limit a log message to 2 bytes less to account
			# for the [ and ] in the array.
			@maxLogByteSize = 30000
			@maxMessageIndex = 9
			@publishQueue = [[]]
			@messageIndex = 0
			@publishQueueRemainingBytes = @maxLogByteSize
			@logsOverflow = false
			super()

		doPublish = =>
				return if @publishQueue[0].length is 0
				channel = _loggerConfig.channel
				message = @publishQueue.shift()
				@pubnub.publish({ channel, message })
				if @publishQueue.length is 0
					@publishQueue = [[]]
					@publishQueueRemainingBytes = @maxLogByteSize
				@messageIndex = Math.max(@messageIndex - 1, 0)
				@logsOverflow = false if @messageIndex < @maxMessageIndex

		start: =>
			if _loggerConfig.offlineMode
				return
			@pubnub = PUBNUB.init(_loggerConfig.pubnub)
			super()

		publish: (message) =>
			# Disable sending logs for bandwidth control
			return if _loggerConfig.offlineMode or !@isEnabled or (@messageIndex >= @maxMessageIndex and @publishQueueRemainingBytes <= 0)
			if _.isString(message)
				message = { message }
			msg = {
				t: message.timestamp ? Date.now()
				m: message.message ? ''
			}
			if message.isSystem
				msg.s = 1
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
				@publishQueue[messageIndex] = [ { m: 'Warning! Some logs dropped due to high load', t: Date.now(), s: 1 } ]
				@publishQueueRemainingBytes = 0

	class NativeLogger
		constructor: ->
			@logPublishInterval = 1000
			@maxLogMessagesSize = 300000
			@publishQueue = []
			@publishQueueRemainingBytes = @maxLogMessagesSize
			super()

		doPublish: =>
			
		publish: (message) =>
			if _loggerConfig.offlineMode or !@enable
				return



	exports.log = ->
		_logger.publish(arguments...)

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
							msg = { timestamp: logLine.substr(0, space), message: logLine.substr(space + 1) }
							logger.publish(msg)
					.on 'error', (err) ->
						console.error('Error on container logs', err, err.stack)
						attached[app.containerName] = false
					.on 'end', ->
						attached[app.containerName] = false
