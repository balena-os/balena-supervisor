url = require 'url'
https = require 'https'
stream = require 'stream'
zlib = require 'zlib'

_ = require 'lodash'
Promise = require 'bluebird'
es = require 'event-stream'
Lock = require 'rwlock'
{ checkTruthy } = require './lib/validation'

ZLIB_TIMEOUT = 100
COOLDOWN_PERIOD = 5 * 1000
KEEPALIVE_TIMEOUT = 60 * 1000
RESPONSE_GRACE_PERIOD = 5 * 1000

MAX_LOG_LENGTH = 10 * 1000
MAX_PENDING_BYTES = 256 * 1024

class LogBackend
	constructor: (apiEndpoint, uuid, deviceApiKey) ->
		@publishEnabled = true
		@offlineMode = false

		@_req = null
		@_dropCount = 0
		@_writable = true
		@_gzip = null

		@_opts = url.parse("#{apiEndpoint}/device/v2/#{uuid}/log-stream")
		@_opts.method = 'POST'
		@_opts.headers = {
			'Authorization': "Bearer #{deviceApiKey}"
			'Content-Type': 'application/x-ndjson'
			'Content-Encoding': 'gzip'
		}

		# This stream serves serves as a message buffer during reconnections
		# while we unpipe the old, malfunctioning connection and then repipe a
		# new one.
		@_stream = new stream.PassThrough({
			allowHalfOpen: true
			# We halve the high watermark because a passthrough stream has two
			# buffers, one for the writable and one for the readable side. The
			# write() call only returns false when both buffers are full.
			highWaterMark: MAX_PENDING_BYTES / 2
		})
		@_stream.on 'drain', =>
			@_writable = true
			@_flush()
			if @_dropCount > 0
				@_write({
					message: "Warning: Suppressed #{@_dropCount} message(s) due to high load"
					timestamp: Date.now()
					isSystem: true
					isStdErr: true
				})
				@_dropCount = 0

		@_setup = _.throttle(@_setup, COOLDOWN_PERIOD)
		@_snooze = _.debounce(@_teardown, KEEPALIVE_TIMEOUT)

		# Flushing every ZLIB_TIMEOUT hits a balance between compression and
		# latency. When ZLIB_TIMEOUT is 0 the compression ratio is around 5x
		# whereas when ZLIB_TIMEOUT is infinity the compession ratio is around 10x.
		@_flush = _.throttle(@_flush, ZLIB_TIMEOUT, leading: false)

	_setup: ->
		@_req = https.request(@_opts)

		# Since we haven't sent the request body yet, and never will,the
		# only reason for the server to prematurely respond is to
		# communicate an error. So teardown the connection immediately
		@_req.on 'response', (res) =>
			console.log('LogBackend: server responded with status code:', res.statusCode)
			@_teardown()

		@_req.on('timeout', => @_teardown())
		@_req.on('close', => @_teardown())
		@_req.on 'error', (err) =>
			console.log('LogBackend: unexpected error:', err)
			@_teardown()

		# Immediately flush the headers. This gives a chance to the server to
		# respond with potential errors such as 401 authentication error
		@_req.flushHeaders()

		# We want a very low writable high watermark to prevent having many
		# chunks stored in the writable queue of @_gzip and have them in
		# @_stream instead. This is desirable because once @_gzip.flush() is
		# called it will do all pending writes with that flush flag. This is
		# not what we want though. If there are 100 items in the queue we want
		# to write all of them with Z_NO_FLUSH and only afterwards do a
		# Z_SYNC_FLUSH to maximize compression
		@_gzip = zlib.createGzip(writableHighWaterMark: 1024)
		@_gzip.on('error', => @_teardown())
		@_gzip.pipe(@_req)

		# Only start piping if there has been no error after the header flush.
		# Doing it immediately would potentialy lose logs if it turned out that
		# the server is unavailalbe because @_req stream would consume our
		# passthrough buffer
		@_timeout = setTimeout(=>
			@_stream.pipe(@_gzip)
			@_flush()
		, RESPONSE_GRACE_PERIOD)

	_teardown: ->
		if @_req isnt null
			clearTimeout(@_timeout)
			@_req.removeAllListeners()
			@_req.on('error', _.noop)
			# no-op if pipe hasn't happened yet
			@_stream.unpipe(@_gzip)
			@_gzip.end()
			@_req = null

	_flush: ->
		@_gzip.flush(zlib.Z_SYNC_FLUSH)

	_write: (msg) ->
		@_snooze()

		if @_req is null
			@_setup()

		if @_writable
			@_writable = @_stream.write(JSON.stringify(msg) + '\n')
			@_flush()
		else
			@_dropCount += 1

	log: (msg) ->
		if @offlineMode or !@publishEnabled
			return

		if !_.isObject(msg)
			return

		msg = _.assign({
			timestamp: Date.now()
			message: ''
		}, msg)

		if !(msg.isSystem or msg.serviceId?)
			return

		msg.message = _.truncate(msg.message, { length: MAX_LOG_LENGTH, omission: '[...]' })

		@_write(msg)

module.exports = class Logger
	constructor: ({ @eventTracker }) ->
		_lock = new Lock()
		@_writeLock = Promise.promisify(_lock.async.writeLock)
		@attached = { stdout: {}, stderr: {} }
		@backend = null

	init: (opts) =>
		@backend = new LogBackend(opts.apiEndpoint, opts.uuid, opts.deviceApiKey)
		@backend.offlineMode = checkTruthy(opts.offlineMode)

	enable: (val) =>
		@backend.publishEnabled = checkTruthy(val) ? true

	logDependent: (msg, device) =>
		msg.uuid = device.uuid
		@backend.log(msg)

	log: (msg) =>
		@backend.log(msg)

	logSystemMessage: (msg, obj, eventName) =>
		messageObj = { message: msg, isSystem: true }
		if obj?.error?
			messageObj.isStdErr = true
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
							msg = { timestamp: (new Date(logLine.substr(0, space))).getTime(), message: logLine.substr(space + 1), serviceId, imageId }
							if stdoutOrStderr == 'stderr'
								msg.isStdErr = true
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
