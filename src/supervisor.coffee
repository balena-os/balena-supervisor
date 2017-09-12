EventEmitter = require 'events'

validation = require './lib/validation'

network = require './network'

EventTracker = require './event-tracker'
DB = require './db'
Config = require './config'
APIBinder = require './api-binder'
DeviceState = require './device-state'
SupervisorAPI = require './supervisor-api'

module.exports = class Supervisor extends EventEmitter
	constructor: ->
		@db = new DB()
		@config = new Config({ @db })
		@eventTracker = new EventTracker()
		@deviceState = new DeviceState({ @config, @db, @eventTracker })
		@apiBinder = new APIBinder({ @config, @db, @deviceState, @eventTracker })
		@deviceState.applications.proxyvisor.bindToAPI(@apiBinder)
		@api = new SupervisorAPI({ @config, @eventTracker, routers: [ @apiBinder.router, @deviceState.router ] })

	normaliseState: =>
		@db.init()
		.tap =>
			@config.init() # Ensures uuid, deviceApiKey, apiSecret and logsChannel
		.then (needsMigration) =>
			# We're updating from an older supervisor, so we need to mark images as supervised and remove all containers
			if needsMigration
				@db.models('legacyData').select()
				.then ([ legacyData ]) =>
					if !legacyData?
						console.log('No legacy data found, skipping migration')
						return
					@deviceState.normaliseLegacy(legacyData)
				.then =>
					@db.finishMigration()

	init: =>
		@normaliseState()
		.then =>
			@config.getMany([
				'uuid'
				'listenPort'
				'version'
				'apiSecret'
				'apiTimeout'
				'logsChannelSecret'
				'provisioned'
				'resinApiEndpoint'
				'offlineMode'
				'mixpanelToken'
				'mixpanelHost'
				'username'
				'osVersion'
				'osVariant'
				'connectivityCheckEnabled'
			])
		.then (conf) =>
			@eventTracker.init({
				offlineMode: conf.offlineMode
				mixpanelToken: conf.mixpanelToken
				mixpanelHost: conf.mixpanelHost
				uuid: conf.uuid
			})
			.then =>
				@eventTracker.track('Supervisor start')
				@deviceState.init()
			.then =>
				# initialize API
				console.log('Starting API server')
				@api.listen(@config.constants.allowedInterfaces, conf.listenPort, conf.apiTimeout)
				@deviceState.on('shutdown', => @api.stop())
			.then =>
				network.startConnectivityCheck(conf.resinApiEndpoint, conf.connectivityCheckEnabled)
				@config.on 'change', (changedConfig) ->
					network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled) if changedConfig.connectivityCheckEnabled?
					@deviceState.reportCurrentState(api_secret: changedConfig.apiSecret) if changedConfig.apiSecret?

				# Let API know what version we are, and our api connection info.
				console.log('Reporting initial state, supervisor version and API info')
				@deviceState.reportCurrentState(
					api_port: conf.listenPort
					api_secret: conf.apiSecret
					os_version: conf.osVersion
					os_variant: conf.osVariant
					supervisor_version: conf.version
					provisioning_progress: null
					provisioning_state: ''
					status: 'Idle'
					download_progress: null
					logs_channel: conf.logsChannelSecret
					update_failed: false
					update_pending: false
					update_downloaded: false
				)

				console.log('Starting periodic check for IP addresses')
				network.startIPAddressUpdate (addresses) =>
					@deviceState.reportCurrentState(
						ip_address: addresses.join(' ')
					)
				, @config.constants.ipAddressUpdateInterval
			.then =>
				@deviceState.loadTargetFromFile() if !conf.provisioned
			.then =>
				@config.get('targetStateSet')
			.then (targetStateSet) =>
				@deviceState.triggerApplyTarget() if validation.checkTruthy(targetStateSet)
			.then =>
				@apiBinder.init() # this will first try to provision if it's a new device
