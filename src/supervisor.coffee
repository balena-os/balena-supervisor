EventEmitter = require 'events'

{ EventTracker } = require './event-tracker'
{ DB } = require './db'
{ Config } = require './config'
{ APIBinder } = require './api-binder'
DeviceState = require './device-state'
{ SupervisorAPI } = require './supervisor-api'
{ Logger } = require './logger'

constants = require './lib/constants'

startupConfigFields = [
	'uuid'
	'listenPort'
	'apiEndpoint'
	'apiSecret'
	'apiTimeout'
	'unmanaged'
	'deviceApiKey'
	'mixpanelToken'
	'mixpanelHost'
	'loggingEnabled'
	'localMode'
	'legacyAppsPresent'
]

module.exports = class Supervisor extends EventEmitter
	constructor: ->
		@db = new DB()
		@config = new Config({ @db })
		@eventTracker = new EventTracker()
		@logger = new Logger({ @db, @eventTracker })
		@deviceState = new DeviceState({ @config, @db, @eventTracker, @logger })
		@apiBinder = new APIBinder({ @config, @db, @deviceState, @eventTracker })

		# FIXME: rearchitect proxyvisor to avoid this circular dependency
		# by storing current state and having the APIBinder query and report it / provision devices
		@deviceState.applications.proxyvisor.bindToAPI(@apiBinder)
		# We could also do without the below dependency, but it's part of a much larger refactor
		@deviceState.applications.apiBinder = @apiBinder

		@api = new SupervisorAPI({
			@config,
			@eventTracker,
			routers: [
				@apiBinder.router,
				@deviceState.router
			],
			healthchecks: [
				@apiBinder.healthcheck.bind(@apiBinder),
				@deviceState.healthcheck.bind(@deviceState)
			]
		})

	init: =>
		@db.init()
		.tap =>
			@config.init() # Ensures uuid, deviceApiKey, apiSecret
		.then =>
			@config.getMany(startupConfigFields)
		.then (conf) =>
			# We can't print to the dashboard until the logger has started up,
			# so we leave a trail of breadcrumbs in the logs in case runtime
			# fails to get to the first dashboard logs
			console.log('Starting event tracker')
			@eventTracker.init(conf)
			.then =>
				console.log('Starting up api binder')
				@apiBinder.initClient()
			.then =>
				console.log('Starting logging infrastructure')
				@logger.init({
					apiEndpoint: conf.apiEndpoint,
					uuid: conf.uuid,
					deviceApiKey: conf.deviceApiKey,
					unmanaged: conf.unmanaged,
					enableLogs: conf.loggingEnabled,
					localMode: conf.localMode
				})
			.then =>
				@logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start')
			.then =>
				if conf.legacyAppsPresent
					console.log('Legacy app detected, running migration')
					@deviceState.normaliseLegacy(@apiBinder.balenaApi)
			.then =>
				@deviceState.init()
			.then =>
				# initialize API
				console.log('Starting API server')
				@api.listen(constants.allowedInterfaces, conf.listenPort, conf.apiTimeout)
				@deviceState.on('shutdown', => @api.stop())
			.then =>
				@apiBinder.start() # this will first try to provision if it's a new device
