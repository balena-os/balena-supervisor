Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll(require('fs'))

systemd = require './lib/systemd'
{ checkTruthy, checkInt } = require './lib/validation'
{ UnitNotLoadedError } = require './lib/errors'
configUtils = require './lib/config-utils'

forbiddenConfigKeys = [
	'disable_commandline_tags'
	'cmdline'
	'kernel'
	'kernel_address'
	'kernel_old'
	'ramfsfile'
	'ramfsaddr'
	'initramfs'
	'device_tree_address'
	'init_uart_baud'
	'init_uart_clock'
	'init_emmc_clock'
	'boot_delay'
	'boot_delay_ms'
	'avoid_safe_mode'
]

vpnServiceName = 'openvpn-resin'

module.exports = class DeviceConfig
	constructor: ({ @db, @config, @logger }) ->
		@rebootRequired = false
		@configKeys = {
			appUpdatePollInterval: { envVarName: 'RESIN_SUPERVISOR_POLL_INTERVAL', varType: 'int', defaultValue: '60000' }
			localMode: { envVarName: 'RESIN_SUPERVISOR_LOCAL_MODE', varType: 'bool', defaultValue: 'false' }
			connectivityCheckEnabled: { envVarName: 'RESIN_SUPERVISOR_CONNECTIVITY_CHECK', varType: 'bool', defaultValue: 'true' }
			loggingEnabled: { envVarName: 'RESIN_SUPERVISOR_LOG_CONTROL', varType: 'bool', defaultValue: 'true' }
			delta: { envVarName: 'RESIN_SUPERVISOR_DELTA', varType: 'bool', defaultValue: 'false' }
			deltaRequestTimeout: { envVarName: 'RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT', varType: 'int', defaultValue: '30000' }
			deltaApplyTimeout: { envVarName: 'RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT', varType: 'int', defaultValue: '' }
			deltaRetryCount: { envVarName: 'RESIN_SUPERVISOR_DELTA_RETRY_COUNT', varType: 'int', defaultValue: '30' }
			deltaRetryInterval: { envVarName: 'RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL', varType: 'int', defaultValue: '10000' }
			deltaVersion: { envVarName: 'RESIN_SUPERVISOR_DELTA_VERSION', varType: 'int', defaultValue: '2' }
			lockOverride: { envVarName: 'RESIN_SUPERVISOR_OVERRIDE_LOCK', varType: 'bool', defaultValue: 'false' }
			nativeLogger: { envVarName: 'RESIN_SUPERVISOR_NATIVE_LOGGER', varType: 'bool', defaultValue: 'true' }
		}
		@validKeys = [ 'RESIN_SUPERVISOR_VPN_CONTROL', 'RESIN_OVERRIDE_LOCK' ].concat(_.map(@configKeys, 'envVarName'))
		@actionExecutors = {
			changeConfig: (step) =>
				@logger.logConfigChange(step.humanReadableTarget)
				@config.set(step.target)
				.then =>
					@logger.logConfigChange(step.humanReadableTarget, { success: true })
				.tapCatch (err) =>
					@logger.logConfigChange(step.humanReadableTarget, { err })
			setVPNEnabled: (step, { initial = false } = {}) =>
				logValue = { RESIN_SUPERVISOR_VPN_CONTROL: step.target }
				if !initial
					@logger.logConfigChange(logValue)
				@setVPNEnabled(step.target)
				.then =>
					if !initial
						@logger.logConfigChange(logValue, { success: true })
				.tapCatch (err) =>
					@logger.logConfigChange(logValue, { err })
			setBootConfig: (step) =>
				@config.get('deviceType')
				.then (deviceType) =>
					@setBootConfig(deviceType, step.target)
		}
		@validActions = _.keys(@actionExecutors)

	setTarget: (target, trx) =>
		db = trx ? @db.models
		confToUpdate = {
			targetValues: JSON.stringify(target)
		}
		db('deviceConfig').update(confToUpdate)

	getTarget: ({ initial = false } = {}) =>
		@db.models('deviceConfig').select('targetValues')
		.then ([ devConfig ]) =>
			return Promise.all [
				JSON.parse(devConfig.targetValues)
				@config.get('deviceType')
			]
		.then ([ conf, deviceType ]) =>
			conf = configUtils.filterConfigKeys(deviceType, @validKeys, conf)
			if initial or !conf.RESIN_SUPERVISOR_VPN_CONTROL?
				conf.RESIN_SUPERVISOR_VPN_CONTROL = 'true'
			for own k, { envVarName, defaultValue } of @configKeys
				conf[envVarName] ?= defaultValue
			return conf

	getCurrent: =>
		@config.getMany([ 'deviceType' ].concat(_.keys(@configKeys)))
		.then (conf) =>
			Promise.join(
				@getVPNEnabled()
				@getBootConfig(conf.deviceType)
				(vpnStatus, bootConfig) =>
					currentConf = {
						RESIN_SUPERVISOR_VPN_CONTROL: (vpnStatus ? 'true').toString()
					}
					for own key, { envVarName } of @configKeys
						currentConf[envVarName] = (conf[key] ? '').toString()
					return _.assign(currentConf, bootConfig)
			)

	getDefaults: =>
		Promise.try =>
			return _.extend({
				RESIN_SUPERVISOR_VPN_CONTROL: 'true'
			}, _.mapValues(_.mapKeys(@configKeys, 'envVarName'), 'defaultValue'))

	bootConfigChangeRequired: (deviceType, current, target) =>
		targetBootConfig = configUtils.envToBootConfig(deviceType, target)
		currentBootConfig = configUtils.envToBootConfig(deviceType, current)
		if !_.isEqual(currentBootConfig, targetBootConfig)
			for key in forbiddenConfigKeys
				if currentBootConfig[key] != targetBootConfig[key]
					err = "Attempt to change blacklisted config value #{key}"
					@logger.logSystemMessage(err, { error: err }, 'Apply boot config error')
					throw new Error(err)
			return true
		return false

	getRequiredSteps: (currentState, targetState) =>
		current = _.clone(currentState.local?.config ? {})
		target = _.clone(targetState.local?.config ? {})
		steps = []
		@config.getMany([ 'deviceType', 'offlineMode' ])
		.then ({ deviceType, offlineMode }) =>
			configChanges = {}
			humanReadableConfigChanges = {}
			match = {
				'bool': (a, b) ->
					checkTruthy(a) == checkTruthy(b)
				'int': (a, b) ->
					checkInt(a) == checkInt(b)
			}
			# If the legacy lock override is used, place it as the new variable
			if checkTruthy(target['RESIN_OVERRIDE_LOCK'])
				target['RESIN_SUPERVISOR_OVERRIDE_LOCK'] = target['RESIN_OVERRIDE_LOCK']
			for own key, { envVarName, varType } of @configKeys
				if !match[varType](current[envVarName], target[envVarName])
					configChanges[key] = target[envVarName]
					humanReadableConfigChanges[envVarName] = target[envVarName]
			if !_.isEmpty(configChanges)
				steps.push({
					action: 'changeConfig'
					target: configChanges
					humanReadableTarget: humanReadableConfigChanges
				})
				return
			if !checkTruthy(offlineMode) &&
				!_.isEmpty(target['RESIN_SUPERVISOR_VPN_CONTROL']) &&
				checkTruthy(current['RESIN_SUPERVISOR_VPN_CONTROL']) != checkTruthy(target['RESIN_SUPERVISOR_VPN_CONTROL'])
					steps.push({
						action: 'setVPNEnabled'
						target: target['RESIN_SUPERVISOR_VPN_CONTROL']
					})
			if @bootConfigChangeRequired(deviceType, current, target)
				steps.push({
					action: 'setBootConfig'
					target
				})
			if !_.isEmpty(steps)
				return
			if @rebootRequired
				steps.push({
					action: 'reboot'
				})
			return
		.return(steps)

	executeStepAction: (step, opts) =>
		@actionExecutors[step.action](step, opts)

	readBootConfig: (deviceType) ->
		fs.readFileAsync(configUtils.getBootConfigPath(deviceType), 'utf8')

	getBootConfig: (deviceType) =>
		Promise.try =>
			if !configUtils.isConfigDeviceType(deviceType)
				return {}
			@readBootConfig(deviceType)
			.then (configTxt) ->

				config = configUtils.parseBootConfig(deviceType, configTxt)
				return configUtils.bootConfigToEnv(deviceType, config)

	setBootConfig: (deviceType, target) =>
		Promise.try =>
			if !configUtils.isConfigDeviceType(deviceType)
				return false
			conf = configUtils.envToBootConfig(deviceType, target)
			@logger.logSystemMessage("Applying boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config in progress')

			configUtils.setBootConfig(deviceType, conf)
			.then =>
				@logger.logSystemMessage("Applied boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config success')
				@rebootRequired = true
				return true
		.tapCatch (err) =>
			@logger.logSystemMessage("Error setting boot config: #{err}", { error: err }, 'Apply boot config error')

	getVPNEnabled: ->
		systemd.serviceActiveState(vpnServiceName)
		.then (activeState) ->
			return activeState not in [ 'inactive', 'deactivating' ]
		.catchReturn(UnitNotLoadedError, null)

	setVPNEnabled: (val) ->
		enable = checkTruthy(val) ? true
		if enable
			systemd.startService(vpnServiceName)
		else
			systemd.stopService(vpnServiceName)
