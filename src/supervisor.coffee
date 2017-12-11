EventEmitter = require 'events'

EventTracker = require './event-tracker'
DB = require './db'
Config = require './config'
APIBinder = require './api-binder'
DeviceState = require './device-state'
SupervisorAPI = require './supervisor-api'

startupConfigFields = [
	'uuid'
	'listenPort'
	'apiSecret'
	'apiTimeout'
	'offlineMode'
	'mixpanelToken'
	'mixpanelHost'
]

module.exports = class Supervisor extends EventEmitter
	constructor: ->
		@db = new DB()
		@config = new Config({ @db })
		@eventTracker = new EventTracker()
		@deviceState = new DeviceState({ @config, @db, @eventTracker })
		@apiBinder = new APIBinder({ @config, @db, @deviceState, @eventTracker })

		# FIXME: rearchitect proxyvisor to avoid this circular dependency
		# by storing current state and having the APIBinder query and report it / provision devices
		@deviceState.applications.proxyvisor.bindToAPI(@apiBinder)
		@api = new SupervisorAPI({ @config, @eventTracker, routers: [ @apiBinder.router, @deviceState.router ], healthchecks: [ @apiBinder.healthcheck, @deviceState.healthcheck ] })

	init: =>
		@db.init()
		.tap =>
			@config.init() # Ensures uuid, deviceApiKey, apiSecret and logsChannel
		.then =>
			@config.getMany(startupConfigFields)
		.then (conf) =>
			@eventTracker.init(conf)
			.then =>
				@eventTracker.track('Supervisor start')
				@deviceState.init()
			.then =>
				# initialize API
				console.log('Starting API server')
				@api.listen(@config.constants.allowedInterfaces, conf.listenPort, conf.apiTimeout)
				@deviceState.on('shutdown', => @api.stop())
			.then =>
				@apiBinder.init() # this will first try to provision if it's a new device
