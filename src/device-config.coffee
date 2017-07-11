Promise = require 'bluebird'
_ = require 'lodash'

network = require './network'

constants = require './lib/constants'
gosuper = require './lib/gosuper'

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

envToBootConfig = (env) ->
	# We ensure env doesn't have garbage
	parsedEnv = _.pickBy env, (val, key) ->
		return _.startsWith(key, bootConfigEnvVarPrefix)
	parsedEnv = _.mapKeys parsedEnv, (val, key) ->
		key.replace(configRegex(), '$2')
	return parsedEnv

bootConfigToEnv = (config) ->
	confWithEnvKeys = _.mapKeys config, (val, key) ->
		return bootConfigEnvVarPrefix + key
	return _.mapValues confWithEnvKeys, (val, key) ->
		if _.isArray(val)
			return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1')
		else
			return val

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

	getCurrent: ->
		# Use gosuper to get state of log to display
		# Read config.txt and translate to config vars
		# Get config values
		Promise.join(
			getLogToDisplay()
			getVPNEnabled()
			@getBootConfig()
			@config.getMany(['localMode', 'connectivityCheckEnabled', 'loggingEnabled'])
			(logToDisplayStatus, vpnStatus, bootConfig, conf) ->
				currentConf = {
					RESIN_HOST_LOG_TO_DISPLAY: logToDisplayStatus
					RESIN_SUPERVISOR_VPN_CONTROL: vpnStatus
					RESIN_SUPERVISOR_LOCAL_MODE: conf.localMode
					RESIN_SUPERVISOR_LOG_CONTROL: conf.loggingEnabled
					RESIN_SUPERVISOR_CONNECTIVITY_CHECK: conf.connectivityCheckEnabled
					RESIN_SUPERVISOR_POLL_INTERVAL: conf.appUpdatePollInterval.toString()
				}
				return _.assign(currentConf, bootConfig)
		)

	applyTarget: ->
		# Takes the target value of log to display and calls gosuper to set it
		# Takes the config.txt values and writes them to config.txt
		# Takes the special action env vars and sets the supervisor config

	readBootConfig: ->
		fs.readFileAsync(bootConfigPath, 'utf8')
	
	getBootConfig: ->
		readBootConfig()
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
				keyValue = /^[^#]initramfs (.+)/.exec(configStr)
				if keyValue?
					conf[keyValue[1]] = keyValue[2]
					return
			return bootConfigToEnv(conf)

	getLogToDisplay: =>
		gosuper.get('/log-to-display')
		.spread (res, body) ->
			throw new Error("Error getting log to display status: #{body.Error}") if res.statusCode != 200
			return body.Data

	setLogToDisplay: (val) ->
		Promise.try ->
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
				return false

	setBootConfig: (vals) ->
		device.getDeviceType()
		.then (deviceType) ->
			throw new Error('This is not a Raspberry Pi') if !_.startsWith(deviceType, 'raspberry')
			Promise.join parseBootConfigFromEnv(env), parseBootConfigFromEnv(oldEnv), fs.readFileAsync(bootConfigPath, 'utf8'), (configFromApp, oldConfigFromApp, configTxt ) ->
				throw new Error('No boot config to change') if _.isEmpty(configFromApp) or _.isEqual(configFromApp, oldConfigFromApp)
				configFromFS = {}
				configPositions = []
				configStatements = configTxt.split(/\r?\n/)
				_.each configStatements, (configStr) ->
					keyValue = /^([^#=]+)=(.+)/.exec(configStr)
					if keyValue?
						configPositions.push(keyValue[1])
						configFromFS[keyValue[1]] = keyValue[2]
					else
						# This will ensure config.txt filters are in order
						configPositions.push(configStr)
				# configFromApp and configFromFS now have compatible formats
				keysFromApp = _.keys(configFromApp)
				keysFromOldConf = _.keys(oldConfigFromApp)
				keysFromFS = _.keys(configFromFS)
				toBeAdded = _.difference(keysFromApp, keysFromFS)
				toBeDeleted = _.difference(keysFromOldConf, keysFromApp)
				toBeChanged = _.intersection(keysFromApp, keysFromFS)
				toBeChanged = _.filter toBeChanged, (key) ->
					configFromApp[key] != configFromFS[key]
				throw new Error('Nothing to change') if _.isEmpty(toBeChanged) and _.isEmpty(toBeAdded)

				logMessage("Applying boot config: #{JSON.stringify(configFromApp)}", {}, 'Apply boot config in progress')
				# We add the keys to be added first so they are out of any filters
				outputConfig = _.map toBeAdded, (key) -> "#{key}=#{configFromApp[key]}"
				outputConfig = outputConfig.concat _.map configPositions, (key, index) ->
					configStatement = null
					if _.includes(toBeChanged, key)
						configStatement = "#{key}=#{configFromApp[key]}"
					else if !_.includes(toBeDeleted, key)
						configStatement = configStatements[index]
					return configStatement
				# Here's the dangerous part:
				execAsync("mount -t vfat -o remount,rw #{bootBlockDevice} #{bootMountPoint}")
				.then ->
					fs.writeFileAsync(bootConfigPath + '.new', _.reject(outputConfig, _.isNil).join('\n'))
				.then ->
					fs.renameAsync(bootConfigPath + '.new', bootConfigPath)
				.then ->
					execAsync('sync')
				.then ->
					logMessage("Applied boot config: #{JSON.stringify(configFromApp)}", {}, 'Apply boot config success')
					return true
				.catch (err) ->
					logMessage("Error setting boot config: #{err}", { error: err }, 'Apply boot config error')
					throw err
		.catch (err) ->
			console.log('Will not set boot config: ', err)
			return false

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