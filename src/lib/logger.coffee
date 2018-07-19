url = require 'url'
https = require 'https'
stream = require 'stream'
zlib = require 'zlib'

_ = require 'lodash'
Docker = require 'dockerode'
Promise = require 'bluebird'
es = require 'event-stream'
bootstrap = require '../bootstrap'
config = require '../config'
utils = require '../utils'

ZLIB_TIMEOUT = 100
COOLDOWN_PERIOD = 5 * 1000
KEEPALIVE_TIMEOUT = 60 * 1000
RESPONSE_GRACE_PERIOD = 5 * 1000

MAX_LOG_LENGTH = 10 * 1000
MAX_PENDING_BYTES = 256 * 1024

publishEnabled = true

class LogBackend
	constructor: (uuid, apiKey) ->
		@_req = null
		@_dropCount = 0
		@_writable = true
		@_gzip = null

		@_opts = url.parse("#{config.apiEndpoint}/device/v2/#{uuid}/log-stream")
		@_opts.method = 'POST'
		@_opts.headers = {
			'Authorization': "Bearer #{apiKey}"
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

		# Immediately flush the headers. This gives a chance to the server to
		# respond with potential errors such as 401 authentication error
		@_gzip.write('\n')
		@_gzip.flush(zlib.Z_SYNC_FLUSH)

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
		if !publishEnabled
			return

		if !_.isObject(msg)
			return

		msg = _.assign({
			timestamp: Date.now()
			message: ''
			isSystem: false
		}, msg)

		msg.message = msg.message.slice(0, MAX_LOG_LENGTH)

		@_write(msg)

# Callback function to enable/disable logs

exports.resinLogControl = (val) ->
	publishEnabled = !(val == 'false')
	console.log('Logs enabled: ' + val)
	return true

exports.logDependent = (msg, uuid) ->
	msg.uuid = uuid
	exports.log(msg)

exports.log = _.noop

bootstrap.done
.then ->
	Promise.all([ utils.getConfig('uuid'), utils.getConfig('apiKey') ])
.spread (uuid, apiKey) ->
	logger = new LogBackend(uuid, apiKey)

	exports.log = (msg) ->
		logger.log(msg)

initialised = new Promise (resolve) ->
	exports.init = (config) ->
		publishEnabled = !config.offlineMode
		resolve(config)

dockerPromise = initialised.then (config) ->
	docker = Promise.promisifyAll(new Docker(socketPath: config.dockerSocket))
	# Hack dockerode to promisify internal classes' prototypes
	Promise.promisifyAll(docker.getImage().constructor.prototype)
	Promise.promisifyAll(docker.getContainer().constructor.prototype)
	return docker

exports.attach = (app) ->
	dockerPromise.then (docker) ->
		docker.getContainer(app.containerId)
		.logsAsync({ follow: true, stdout: true, stderr: true, timestamps: true, since: Math.floor(Date.now() / 1000) })
		.then (stream) ->
			stream.pipe(es.split())
			.on 'data', (logLine) ->
				space = logLine.indexOf(' ')
				if space > 0
					msg = { timestamp: (new Date(logLine.substr(0, space))).getTime(), message: logLine.substr(space + 1) }
					exports.log(msg)
			.on 'error', (err) ->
				console.error('Error on container logs', err, err.stack)
