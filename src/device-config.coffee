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
		@validActions = [ 'changeConfig', 'setLogToDisplay', 'setBootConfig' ]
		@configKeys = {
			appUpdatePollInterval: [ 'RESIN_SUPERVISOR_POLL_INTERVAL', 'int' ]
			localMode: [ 'RESIN_SUPERVISOR_LOCAL_MODE', 'bool' ]
			connectivityCheckEnabled: [ 'RESIN_SUPERVISOR_CONNECTIVITY_CHECK', 'bool' ]
			loggingEnabled: [ 'RESIN_SUPERVISOR_LOG_CONTROL', 'bool' ]
		}
		@validKeys = [
			'RESIN_HOST_LOG_TO_DISPLAY'
			'RESIN_SUPERVISOR_VPN_CONTROL'
			'RESIN_SUPERVISOR_LOCAL_MODE'
			'RESIN_SUPERVISOR_LOG_CONTROL'
			'RESIN_SUPERVISOR_CONNECTIVITY_CHECK'
			'RESIN_SUPERVISOR_POLL_INTERVAL'
		]

	setTarget: (target, trx) =>
		db = trx ? @db.models
		confToUpdate = {
			targetValues: JSON.stringify(target)
		}
		db('deviceConfig').update(confToUpdate)

	filterConfigKeys: (conf) =>
		_.pickBy conf, (v, k) =>
			_.includes(@validKeys, k) or _.startsWith(k, bootConfigEnvVarPrefix)

	getTarget: =>
		@db.models('deviceConfig').select('targetValues')
		.then ([ devConfig ]) ->
			return JSON.parse(devConfig.targetValues)
		.then (conf) =>
			conf = @filterConfigKeys(conf)
			conf.RESIN_HOST_LOG_TO_DISPLAY ?= ''
			conf.RESIN_SUPERVISOR_VPN_CONTROL ?= 'true'
			conf.RESIN_SUPERVISOR_LOCAL_MODE ?= 'false'
			conf.RESIN_SUPERVISOR_LOG_CONTROL ?= 'true'
			conf.RESIN_SUPERVISOR_CONNECTIVITY_CHECK ?= 'true'
			conf.RESIN_SUPERVISOR_POLL_INTERVAL ?= '60000'
			return conf

	getCurrent: =>
		@config.getMany([ 'deviceType', 'localMode', 'connectivityCheckEnabled', 'loggingEnabled', 'appUpdatePollInterval' ])
		.then (conf) =>
			Promise.join(
				@getLogToDisplay()
				@getVPNEnabled()
				@getBootConfig(conf.deviceType)
				(logToDisplayStatus, vpnStatus, bootConfig) ->
					currentConf = {
						RESIN_HOST_LOG_TO_DISPLAY: (logToDisplayStatus ? '').toString()
						RESIN_SUPERVISOR_VPN_CONTROL: (vpnStatus ? 'true').toString()
						RESIN_SUPERVISOR_LOCAL_MODE: (conf.localMode ? 'false').toString()
						RESIN_SUPERVISOR_LOG_CONTROL: (conf.loggingEnabled ? 'true').toString()
						RESIN_SUPERVISOR_CONNECTIVITY_CHECK: (conf.connectivityCheckEnabled ? 'true').toString()
						RESIN_SUPERVISOR_POLL_INTERVAL: (conf.appUpdatePollInterval ? '60000').toString()
					}
					return _.assign(currentConf, bootConfig)
			)

	bootConfigChangeRequired: (deviceType, current, target) =>
		targetBootConfig = @envToBootConfig(target)
		currentBootConfig = @envToBootConfig(current)
		if !_.isEqual(currentBootConfig, targetBootConfig)
			_.forEach forbiddenConfigKeys, (key) =>
				if currentBootConfig[key] != targetBootConfig[key]
					err = "Attempt to change blacklisted config value #{key}"
					@logger.logSystemMessage(err, { error: err }, 'Apply boot config error')
					throw new Error(err)
			return true
		else return false

	getRequiredSteps: (currentState, targetState, stepsInProgress) =>
		current = currentState.local?.config ? {}
		target = targetState.local?.config ? {}
		steps = []
		@config.get('deviceType')
		.then (deviceType) =>
			configChanges = {}
			match = {
				'bool': (a, b) ->
					checkTruthy(a) == checkTruthy(b)
				'int': (a, b) ->
					checkInt(a) == checkInt(b)
			}
			_.forEach @configKeys, ([ envVarName, varType ], key) ->
				configChanges[key] = target[envVarName] if !match[varType](current[envVarName], target[envVarName])
			if !_.isEmpty(configChanges)
				steps.push({
					action: 'changeConfig'
					target: configChanges
				})
				return
			if !_.isUndefined(current['RESIN_HOST_LOG_TO_DISPLAY'])
				if !_.isEmpty(target['RESIN_HOST_LOG_TO_DISPLAY']) && checkTruthy(current['RESIN_HOST_LOG_TO_DISPLAY']) != checkTruthy(target['RESIN_HOST_LOG_TO_DISPLAY'])
					steps.push({
						action: 'setLogToDisplay'
						target: target['RESIN_HOST_LOG_TO_DISPLAY']
					})
			if @bootConfigChangeRequired(deviceType, current, target)
				steps.push({
					action: 'setBootConfig'
					target
				})
			return if !_.isEmpty(steps)
			if @rebootRequired
				steps.push({
					action: 'reboot'
				})
			return
		.then ->
			needsWait = !_.isEmpty(steps)
			filteredSteps = _.filter steps, (step) ->
				!_.find(stepsInProgress, (stepInProgress) -> _.isEqual(stepInProgress, step))?

			if _.isEmpty(filteredSteps) and needsWait
				return [{ action: 'noop' }]
			else return filteredSteps

	executeStepAction: (step) =>
		switch step.action
			when 'changeConfig'
				@config.set(step.target)
			when 'setLogToDisplay'
				@setLogToDisplay(step.target)
			when 'setBootConfig'
				@config.get('deviceType')
				.then (deviceType) =>
					@setBootConfig(deviceType, step.target)

	envToBootConfig: (env) ->
		# We ensure env doesn't have garbage
		parsedEnv = _.pickBy env, (val, key) ->
			return _.startsWith(key, bootConfigEnvVarPrefix)
		parsedEnv = _.mapKeys parsedEnv, (val, key) ->
			key.replace(configRegex(), '$2')
		parsedEnv = _.mapValues parsedEnv, (val, key) ->
			if _.includes(arrayConfigKeys, key)
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
			return {} if !_.startsWith(deviceType, 'raspberry')
			@readBootConfig()
			.then (configTxt) =>
				conf = {}
				configStatements = configTxt.split(/\r?\n/)
				_.forEach configStatements, (configStr) ->
					keyValue = /^([^#=]+)=(.+)/.exec(configStr)
					if keyValue?
						if !_.includes(arrayConfigKeys, keyValue[1])
							conf[keyValue[1]] = keyValue[2]
							return
						else
							conf[keyValue[1]] ?= []
							conf[keyValue[1]].push(keyValue[2])
							return
					keyValue = /^(initramfs) (.+)/.exec(configStr)
					if keyValue?
						conf[keyValue[1]] = keyValue[2]
						return
				return @bootConfigToEnv(conf)

	getLogToDisplay: ->
		gosuper.get('/v1/log-to-display', { json: true })
		.spread (res, body) ->
			return undefined if res.statusCode == 404
			throw new Error("Error getting log to display status: #{res.statusCode} #{body.Error}") if res.statusCode != 200
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
						@logger.logSystemMessage("#{if enable then 'Enabled' else 'Disabled'} logs to display")
						@rebootRequired = true
					return body.Data
			.catch (err) =>
				@logger.logSystemMessage("Error setting log to display: #{err}", { error: err }, 'Set log to display error')
				throw err

	setBootConfig: (deviceType, target) =>
		Promise.try =>
			conf = @envToBootConfig(target)
			return false if !_.startsWith(deviceType, 'raspberry')
			@logger.logSystemMessage("Applying boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config in progress')
			configStatements = []
			_.forEach conf, (val, key) ->
				if key is 'initramfs'
					configStatements.push("#{key} #{val}")
				else if _.isArray(val)
					configStatements = configStatements.concat _.map val, (entry) ->
						return "#{key}=#{entry}"
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
			throw new Error("Error getting vpn status: #{res.statusCode} #{body.Error}") if res.statusCode != 200
			return Boolean(body.Data)

	setVPNEnabled: (val) ->
		enable = checkTruthy(val) ? true
		gosuper.post('/v1/vpncontrol', { json: true, body: Enable: enable })
		.spread (response, body) ->
			if response.statusCode == 202
				console.log('VPN enabled: ' + enable)
			else
				console.log('Error: ' + body + ' response:' + response.statusCode)
