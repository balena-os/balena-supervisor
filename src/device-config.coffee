Promise = require 'bluebird'
_ = require 'lodash'
childProcess = Promise.promisifyAll(require('child_process'))
fs = Promise.promisifyAll(require('fs'))

device = require './device'

constants = require './lib/constants'
gosuper = require './lib/gosuper'
{ writeFileAtomic } = require './lib/fs-utils'
{ checkTruthy } = require './lib/validation'

hostConfigConfigVarPrefix = 'RESIN_HOST_'
bootConfigEnvVarPrefix = hostConfigConfigVarPrefix + 'CONFIG_'
bootBlockDevice = '/dev/mmcblk0p1'
bootMountPoint = '/mnt/root' + constants.bootMountPoint
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

	setTarget: (target) ->
		confToUpdate = {
			targetValues: JSON.stringify(target)
		}
		@db.models('deviceConfig').update(confToUpdate)
	getTarget: ->
		@db.models('deviceConfig').select('targetValues')
		.then ([ devConfig ]) ->
			return JSON.parse(devConfig.targetValues)

	getCurrent: =>
		@config.getMany(['deviceType', 'localMode', 'connectivityCheckEnabled', 'loggingEnabled'])
		.then (conf) =>
			Promise.join(
				@getLogToDisplay()
				@getVPNEnabled()
				@getBootConfig(conf.deviceType)
				(logToDisplayStatus, vpnStatus, bootConfig) =>
					currentConf = {
						RESIN_HOST_LOG_TO_DISPLAY: logToDisplayStatus.toString()
						RESIN_SUPERVISOR_VPN_CONTROL: vpnStatus.toString()
						RESIN_SUPERVISOR_LOCAL_MODE: conf.localMode.toString()
						RESIN_SUPERVISOR_LOG_CONTROL: conf.loggingEnabled.toString()
						RESIN_SUPERVISOR_CONNECTIVITY_CHECK: conf.connectivityCheckEnabled.toString()
						RESIN_SUPERVISOR_POLL_INTERVAL: conf.appUpdatePollInterval.toString()
					}
					return _.assign(currentConf, @bootConfigToEnv(bootConfig))
			)

	applyTarget: ->
		# Takes the target value of log to display and calls gosuper to set it
		# Takes the config.txt values and writes them to config.txt
		# Takes the special action env vars and sets the supervisor config
		rebootRequired = false
		Promise.join(
			@getCurrent()
			@getTarget()
			(current, target) =>
				Promise.try =>
					if current['RESIN_SUPERVISOR_POLL_INTERVAL'] != target['RESIN_SUPERVISOR_POLL_INTERVAL']
						@config.set({ appUpdatePollInterval: target['RESIN_SUPERVISOR_POLL_INTERVAL'] })
				.then =>
					if current['RESIN_SUPERVISOR_CONNECTIVITY_CHECK'] != target['RESIN_SUPERVISOR_CONNECTIVITY_CHECK']
						@config.set({ connectivityCheckEnabled: target['RESIN_SUPERVISOR_CONNECTIVITY_CHECK'] })
				.then =>
					if current['RESIN_SUPERVISOR_LOCAL_MODE'] != target['RESIN_SUPERVISOR_LOCAL_MODE']
						@config.set({ localMode: target['RESIN_SUPERVISOR_LOCAL_MODE'] })
				.then =>
					if current['RESIN_HOST_LOG_TO_DISPLAY'] != target['RESIN_HOST_LOG_TO_DISPLAY']
						@setLogToDisplay(target['RESIN_HOST_LOG_TO_DISPLAY'])
					else return false
				.then (changed) =>
					rebootRequired = changed
					targetBootConfig = @envToBootConfig(target)
					currentBootConfig = @envToBootConfig(current)
					if !_.isEqual(currentBootConfig, targetBootConfig)
						_.forEach forbiddenConfigKeys, (key) ->
							if current[key] != target[key]
								err = "Attempt to change blacklisted config value #{key}"
								@logger.logSystemMessage(err, { error: err }, 'Apply boot config error')
								throw new Error(err)
						@setBootConfig(targetBootConfig)
					else return false
				.then (changed) ->
					rebootRequired or= changed
					device.reboot() if rebootRequired
		)

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
					keyValue = /^[^#](initramfs) (.+)/.exec(configStr)
					if keyValue?
						conf[keyValue[1]] = keyValue[2]
						return
				return @bootConfigToEnv(conf)

	getLogToDisplay: ->
		gosuper.get('/log-to-display')
		.spread (res, body) ->
			throw new Error("Error getting log to display status: #{body.Error}") if res.statusCode != 200
			return body.Data

	setLogToDisplay: (val) =>
		Promise.try =>
			enable = checkTruthy(val)
			if !enable?
				throw new Error("Invalid value in call to setLogToDisplay: #{val}")
			gosuper.post('/v1/log-to-display', { json: true, body: Enable: enable })
			.spread (response, body) =>
				if response.statusCode != 200
					throw new Error(body.Error)
				else
					if body.Data == true
						@logger.logSystemMessage("#{if enable then 'Enabled' else 'Disabled'} logs to display")
					return body.Data
			.catch (err) =>
				@logger.logSystemMessage("Error setting log to display: #{err}", { error: err }, 'Set log to display error')
				throw err

	setBootConfig: (deviceType, conf) =>
		Promise.try =>
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
				writeFileAtomic(bootConfigPath, configStatements.join('\n'))
			.then ->
				@logger.logSystemMessage("Applied boot config: #{JSON.stringify(conf)}", {}, 'Apply boot config success')
				return true
		.catch (err) ->
			@logger.logSystemMessage("Error setting boot config: #{err}", { error: err }, 'Apply boot config error')
			throw err

	getVPNEnabled: ->
		gosuper.get('/vpncontrol')
		.spread (res, body) ->
			throw new Error("Error getting vpn status: #{body.Error}") if res.statusCode != 200
			return body.Data

	setVPNEnabled: (val) ->
		enable = checkTruthy(val) ? true
		gosuper.post('/v1/vpncontrol', { json: true, body: Enable: enable })
		.spread (response, body) ->
			if response.statusCode == 202
				console.log('VPN enabled: ' + enable)
			else
				console.log('Error: ' + body + ' response:' + response.statusCode)
