EventEmitter = require 'events'

Promise = require 'bluebird'
utils = require './utils'
bootstrap = require './bootstrap'
_ = require 'lodash'

iptables = require './lib/iptables'
network = require './network'

EventTracker = require './event-tracker'
DB = require('./db')
Config = require('./config')
APIBinder = require('./api-binder')
DeviceState = require('./device-state')

module.exports = class Supervisor extends EventEmitter
	constructor: ->
		@db = new DB()
		@config = new Config({ @db })
		@eventTracker = new EventTracker()
		@apiBinder = new APIBinder({ @config, @db })
		@deviceState = new DeviceState({ @config, @db, @eventTracker })
	init: =>
		@db.init()
		.then =>
			@config.init() # Ensures uuid, deviceApiKey, apiSecret and logsChannel
		.then =>
			@config.getMany([
				'uuid'
				'listenPort'
				'version'
				'apiSecret'
				'logsChannelSecret'
				'provisioned'
				'resinApiEndpoint'
				'offlineMode'
				'mixpanelToken'
				'username'
				'osVersion'
				'osVariant'
			])
		.then (conf) =>
			@eventTracker.init({
				offlineMode: conf.offlineMode
				mixpanelToken: conf.mixpanelToken
				uuid: conf.uuid
			})
			.then =>
				@eventTracker.track('Supervisor start')
				@deviceState.init()
			.then =>
				network.startConnectivityCheck(conf.resinApiEndpoint)
				# Let API know what version we are, and our api connection info.
				console.log('Updating supervisor version and api info')
				@deviceState.reportCurrent(
					api_port: conf.listenPort
					api_secret: conf.apiSecret
					os_version: conf.osVersion
					os_variant: conf.osVariant
					supervisor_version: conf.version
					provisioning_progress: null
					provisioning_state: ''
					download_progress: null
					logs_channel: conf.logsChannelSecret
				)
				.then =>
					console.log('Starting periodic check for IP addresses..')
					network.startIPAddressUpdate (addresses) =>
						@deviceState.reportCurrent(
							ip_address: addresses.join(' ')
						)
				.then =>
					@deviceState.loadTargetsFromFile() if !conf.provisioned
				.then =>
					@deviceState.applyAndMaintainTarget()
				.then =>
					# initialize API
					console.log('Starting API server..')
					iptables.rejectOnAllInterfacesExcept(@config.constants.allowedInterfaces, conf.listenPort)
					.then ->
						apiServer = api(application).listen(conf.listenPort)
						apiServer.timeout = conf.apiTimeout
				.then =>
					@apiBinder.init() # this will first try to provision if it's a new device
