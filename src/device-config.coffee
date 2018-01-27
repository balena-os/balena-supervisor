Promise = require 'bluebird'
_ = require 'lodash'
childProcess = Promise.promisifyAll(require('child_process'))
fs = Promise.promisifyAll(require('fs'))

constants = require './lib/constants'
gosuper = require './lib/gosuper'
fsUtils = require './lib/fs-utils'
{ checkTruthy, checkInt } = require './lib/validation'

hostConfigConfigVarPrefix = 'RESIN_HOST_'
bootConfigEnvVarPrefix = hostConfigConfigVarPrefix + 'CONFIG_'
bootBlockDevice = '/dev/mmcblk0p1'
bootMountPoint = constants.rootMountPoint + constants.bootMountPoint
bootConfigPath = bootMountPoint + '/config.txt'
configRegex = ->
	new RegExp('(' + _.escapeRegExp(bootConfigEnvVarPrefix) + ')(.+)')
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
arrayConfigKeys = [ 'dtparam', 'dtoverlay', 'device_tree_param', 'device_tree_overlay' ]

module.exports = class DeviceConfig
	constructor: ({ @db, @config, @logger }) ->
		@rebootRequired = false
		@gosuperHealthy = true
		@configKeys = {
			appUpdatePollInterval: { envVarName: 'RESIN_SUPERVISOR_POLL_INTERVAL', varType: 'int', defaultValue: '60000' }
			localMode: { envVarName: 'RESIN_SUPERVISOR_LOCAL_MODE', varType: 'bool', defaultValue: 'false' }
			connectivityCheckEnabled: { envVarName: 'RESIN_SUPERVISOR_CONNECTIVITY_CHECK', varType: 'bool', defaultValue: 'true' }
			loggingEnabled: { envVarName: 'RESIN_SUPERVISOR_LOG_CONTROL', varType: 'bool', defaultValue: 'true' }
			delta: { envVarName: 'RESIN_SUPERVISOR_DELTA', varType: 'bool', defaultValue: 'false' }
			deltaRequestTimeout: { envVarName: 'RESIN_SUPERVISOR_DELTA_REQUEST_TIMEOUT', varType: 'int' }
			deltaApplyTimeout: { envVarName: 'RESIN_SUPERVISOR_DELTA_APPLY_TIMEOUT', varType: 'int' }
			deltaRetryCount: { envVarName: 'RESIN_SUPERVISOR_DELTA_RETRY_COUNT', varType: 'int' }
			deltaRetryInterval: { envVarName: 'RESIN_SUPERVISOR_DELTA_RETRY_INTERVAL', varType: 'int' }
			lockOverride: { envVarName: 'RESIN_SUPERVISOR_OVERRIDE_LOCK', varType: 'bool', defaultValue: 'false' }
		}
		@validKeys = [ 'RESIN_HOST_LOG_TO_DISPLAY', 'RESIN_SUPERVISOR_VPN_CONTROL', 'RESIN_OVERRIDE_LOCK' ].concat(_.map(@configKeys, 'envVarName'))
		@actionExecutors = {
			changeConfig: (step) =>
				@logger.logConfigChange(step.humanReadableTarget)
				@config.set(step.target)
				.then =>
					@logger.logConfigChange(step.humanReadableTarget, { success: true })
				.catch (err) =>
					@logger.logConfigChange(step.humanReadableTarget, { err })
					throw err
			setLogToDisplay: (step) =>
				logValue = { RESIN_HOST_LOG_TO_DISPLAY: step.target }
				@logger.logConfigChange(logValue)
				@setLogToDisplay(step.target)
				.then =>
					@logger.logConfigChange(logValue, { success: true })
				.catch (err) =>
					@logger.logConfigChange(logValue, { err })
					throw err
			setVPNEnabled: (step, { initial = false } = {}) =>
				logValue = { RESIN_SUPERVISOR_VPN_CONTROL: step.target }
				if !initial
					@logger.logConfigChange(logValue)
				@setVPNEnabled(step.target)
				.then =>
					if !initial
						@logger.logConfigChange(logValue, { success: true })
				.catch (err) =>
					@logger.logConfigChange(logValue, { err })
					throw err
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

	filterConfigKeys: (conf) =>
		_.pickBy conf, (v, k) =>
			_.includes(@validKeys, k) or _.startsWith(k, bootConfigEnvVarPrefix)

	getTarget: ({ initial = false } = {}) =>
		@db.models('deviceConfig').select('targetValues')
		.then ([ devConfig ]) ->
			return JSON.parse(devConfig.targetValues)
		.then (conf) =>
			conf = @filterConfigKeys(conf)
			conf.RESIN_HOST_LOG_TO_DISPLAY ?= ''
			if initial or !conf.RESIN_SUPERVISOR_VPN_CONTROL?
				conf.RESIN_SUPERVISOR_VPN_CONTROL = 'true'
			for own k, { envVarName, defaultValue } of @configKeys
				conf[envVarName] ?= defaultValue ? ''
			return conf

	getCurrent: =>
		@config.getMany([ 'deviceType' ].concat(_.keys(@configKeys)))
		.then (conf) =>
			Promise.join(
				@getLogToDisplay()
				@getVPNEnabled()
				@getBootConfig(conf.deviceType)
				(logToDisplayStatus, vpnStatus, bootConfig) =>
					currentConf = {
						RESIN_HOST_LOG_TO_DISPLAY: (logToDisplayStatus ? '').toString()
						RESIN_SUPERVISOR_VPN_CONTROL: (vpnStatus ? 'true').toString()
					}
					for own key, { envVarName } of @configKeys
						currentConf[envVarName] = (conf[key] ? '').toString()
					return _.assign(currentConf, bootConfig)
			)

	bootConfigChangeRequired: (deviceType, current, target) =>
		targetBootConfig = @envToBootConfig(target)
		currentBootConfig = @envToBootConfig(current)
		if !_.isEqual(currentBootConfig, targetBootConfig)
			for key in forbiddenConfigKeys
				if currentBootConfig[key] != targetBootConfig[key]
					err = "Attempt to change blacklisted config value #{key}"
					@logger.logSystemMessage(err, { error: err }, 'Apply boot config error')
					throw new Error(err)
			return true
		else return false

	getRequiredSteps: (currentState, targetState) =>
		current = _.clone(currentState.local?.config ? {})
		target = _.clone(targetState.local?.config ? {})
		steps = []
		@config.get('deviceType')
		.then (deviceType) =>
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
			if !_.isUndefined(current['RESIN_HOST_LOG_TO_DISPLAY'])
				if !_.isEmpty(target['RESIN_HOST_LOG_TO_DISPLAY']) && checkTruthy(current['RESIN_HOST_LOG_TO_DISPLAY']) != checkTruthy(target['RESIN_HOST_LOG_TO_DISPLAY'])
					steps.push({
						action: 'setLogToDisplay'
						target: target['RESIN_HOST_LOG_TO_DISPLAY']
					})
			if !_.isEmpty(target['RESIN_SUPERVISOR_VPN_CONTROL']) && checkTruthy(current['RESIN_SUPERVISOR_VPN_CONTROL']) != checkTruthy(target['RESIN_SUPERVISOR_VPN_CONTROL'])
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
		.then ->
			return steps

	executeStepAction: (step, opts) =>
		@actionExecutors[step.action](step, opts)

	envToBootConfig: (env) ->
		# We ensure env doesn't have garbage
		parsedEnv = _.pickBy env, (val, key) ->
			return _.startsWith(key, bootConfigEnvVarPrefix)
		parsedEnv = _.mapKeys parsedEnv, (val, key) ->
			key.replace(configRegex(), '$2')
		parsedEnv = _.mapValues parsedEnv, (val, key) ->
			if _.includes(arrayConfigKeys, key)
				if !_.startsWith(val, '"')
					return [ val ]
				else
					return JSON.parse("[#{val}]")
			else
				return val
		return parsedEnv

	bootConfigToEnv: (config) ->
		confWithEnvKeys = _.mapKeys config, (val, key) ->
			return bootConfigEnvVarPrefix + key
		return _.mapValues confWithEnvKeys, (val, key) ->
			if _.isArray(val)
				return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1')
			else
				return val

	readBootConfig: ->
		fs.readFileAsync(bootConfigPath, 'utf8')

	getBootConfig: (deviceType) =>
		Promise.try =>
			if !_.startsWith(deviceType, 'raspberry')
				return {}
			@readBootConfig()
			.then (configTxt) =>
				conf = {}
				configStatements = configTxt.split(/\r?\n/)
				for configStr in configStatements
					keyValue = /^([^#=]+)=(.+)/.exec(configStr)
					if keyValue?
						if !_.includes(arrayConfigKeys, keyValue[1])
							conf[keyValue[1]] = keyValue[2]
						else
							conf[keyValue[1]] ?= []
							conf[keyValue[1]].push(keyValue[2])
					else
						keyValue = /^(initramfs) (.+)/.exec(configStr)
						if keyValue?
							conf[keyValue[1]] = keyValue[2]
				return @bootConfigToEnv(conf)

	getLogToDisplay: ->
		gosuper.get('/v1/log-to-display', { json: true })
		.spread (res, body) ->
			if res.statusCode == 404
				return undefined
			if res.statusCode != 200
				throw new Error("Error getting log to display status: #{res.statusCode} #{body.Error}")
			return Boolean(body.Data)

	setLogToDisplay: (val) =>
		Promise.try =>
			enable = checkTruthy(val)
			if !enable?
				throw new Error("Invalid value in call to setLogToDisplay: #{val}")
			gosuper.post('/v1/log-to-display', { json: true, body: Enable: enable })
			.spread (response, body) =>
				if response.statusCode != 200
					throw new Error("#{response.statusCode} #{body.Error}")
				else
					if body.Data == true
						@rebootRequired = true
					return body.Data

	setBootConfig: (deviceType, target) =>
		Promise.try =>
			conf = @envToBootConfig(target)
			if !_.startsWith(deviceType, 'raspberry')
				return false
			@logger.logSystemMessage("Applying boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config in progress')
			configStatements = []
			for own key, val of conf
				if key is 'initramfs'
					configStatements.push("#{key} #{val}")
				else if _.isArray(val)
					configStatements = configStatements.concat(_.map(val, (entry) -> "#{key}=#{entry}"))
				else
					configStatements.push("#{key}=#{val}")

			# Here's the dangerous part:
			childProcess.execAsync("mount -t vfat -o remount,rw #{bootBlockDevice} #{bootMountPoint}")
			.then ->
				fsUtils.writeFileAtomic(bootConfigPath, configStatements.join('\n') + '\n')
			.then =>
				@logger.logSystemMessage("Applied boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config success')
				@rebootRequired = true
				return true
		.catch (err) =>
			@logger.logSystemMessage("Error setting boot config: #{err}", { error: err }, 'Apply boot config error')
			throw err

	getVPNEnabled: ->
		gosuper.get('/v1/vpncontrol', { json: true })
		.spread (res, body) ->
			if res.statusCode != 200
				throw new Error("Error getting vpn status: #{res.statusCode} #{body.Error}")
			@gosuperHealthy = true
			return Boolean(body.Data)
		.catch (err) =>
			@gosuperHealthy = false
			throw err

	setVPNEnabled: (val) ->
		enable = checkTruthy(val) ? true
		gosuper.post('/v1/vpncontrol', { json: true, body: Enable: enable })
		.spread (response, body) ->
			if response.statusCode != 202
				throw new Error("#{response.statusCode} #{body?.Error}")
