Docker = require 'dockerode'
PUBNUB = require 'pubnub'
Promise = require 'bluebird'

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
		pubnub = PUBNUB.init(config.pubnub)
		channel = config.channel

		# Redefine original function
		publish = (message) ->
			# Stop pubnub logging loads of "Missing Message" errors, as they are quite distracting
			message or= ' '
			pubnub.publish({ channel, message })

		# Replay queue now that we have initialised the publish function
		publish(args...) for args in publishQueue

	return -> publishQueue.push(arguments)

exports.log = ->
	publish(arguments...)

# Helps in blinking the LED from the given end point.
exports.attach = (app) ->
	dockerPromise.then (docker) ->
		docker.getContainer(app.containerId)
		.attachAsync({ stream: true, stdout: true, stderr: true, tty: true })
		.then (stream) ->
			es.pipeline(
				stream
				es.split()
				es.mapSync(publish)
			)
