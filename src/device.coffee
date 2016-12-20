_ = require 'lodash'
Promise = require 'bluebird'
memoizee = require 'memoizee'
knex = require './db'
utils = require './utils'
{ resinApi } = require './request'
device = exports
config = require './config'
configPath = '/boot/config.json'
execAsync = Promise.promisify(require('child_process').exec)
fs = Promise.promisifyAll(require('fs'))
bootstrap = require './bootstrap'

memoizePromise = _.partial(memoizee, _, promise: true)


exports.getID = memoizePromise ->
	bootstrap.done
	.then ->
		Promise.all([
			knex('config').select('value').where(key: 'apiKey')
			knex('config').select('value').where(key: 'uuid')
		])
	.spread ([{ value: apiKey }], [{ value: uuid }]) ->
		resinApi.get(
			resource: 'device'
			options:
				select: 'id'
				filter:
					uuid: uuid
			customOptions:
				apikey: apiKey
		)
		.timeout(config.apiTimeout)
	.then (devices) ->
		if devices.length is 0
			throw new Error('Could not find this device?!')
		return devices[0].id

exports.reboot = ->
	utils.gosuper.postAsync('/v1/reboot')

exports.hostConfigConfigVarPrefix = 'RESIN_HOST_'
bootConfigEnvVarPrefix = 'RESIN_HOST_CONFIG_'
bootBlockDevice = '/dev/mmcblk0p1'
bootMountPoint = '/mnt/root' + config.bootMountPoint
bootConfigPath = bootMountPoint + '/config.txt'
configRegex = new RegExp('(' + _.escapeRegExp(bootConfigEnvVarPrefix) + ')(.+)')
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
parseBootConfigFromEnv = (env) ->
	# We ensure env doesn't have garbage
	parsedEnv = _.pickBy env, (val, key) ->
		return _.startsWith(key, bootConfigEnvVarPrefix)
	parsedEnv = _.mapKeys parsedEnv, (val, key) ->
		key.replace(configRegex, '$2')
	parsedEnv = _.omit(parsedEnv, forbiddenConfigKeys)
	return parsedEnv

exports.setHostConfig = (env, oldEnv, logMessage) ->
	Promise.join setBootConfig(env, oldEnv, logMessage), setLogToDisplay(env, oldEnv, logMessage), (bootConfigApplied, logToDisplayChanged) ->
		return (bootConfigApplied or logToDisplayChanged)

setLogToDisplay = (env, oldEnv, logMessage) ->
	if env['RESIN_HOST_LOG_TO_DISPLAY']?
		enable = env['RESIN_HOST_LOG_TO_DISPLAY'] != '0'
		utils.gosuper.postAsync('/v1/set-log-to-display', { json: true, body: Enable: enable })
		.spread (response, body) ->
			if response.statusCode != 200
				logMessage("Error setting log to display: #{body.Error}, Status:, #{response.statusCode}", { error: body.Error }, 'Set log to display error')
				return false
			else
				if body.Data == true
					logMessage("#{if enable then 'Enabled' else 'Disabled'} logs to display")
				return body.Data
		.catch (err) ->
			logMessage("Error setting log to display: #{err}", { error: err }, 'Set log to display error')
			return false
	else
		return Promise.resolve(false)

setBootConfig = (env, oldEnv, logMessage) ->
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

exports.getDeviceType = memoizePromise ->
	fs.readFileAsync(configPath, 'utf8')
	.then(JSON.parse)
	.then (configFromFile) ->
		if !configFromFile.deviceType?
			throw new Error('Device type not specified in config file')
		return configFromFile.deviceType

do ->
	applyPromise = Promise.resolve()
	targetState = {}
	actualState = {}
	updateState = { update_pending: false, update_failed: false, update_downloaded: false }

	getStateDiff = ->
		_.omitBy targetState, (value, key) ->
			actualState[key] is value

	applyState = ->
		stateDiff = getStateDiff()
		if _.size(stateDiff) is 0
			return
		applyPromise = Promise.join(
			knex('config').select('value').where(key: 'apiKey')
			device.getID()
			([{ value: apiKey }], deviceID) ->
				stateDiff = getStateDiff()
				if _.size(stateDiff) is 0 || !apiKey?
					return
				resinApi.patch
					resource: 'device'
					id: deviceID
					body: stateDiff
					customOptions:
						apikey: apiKey
				.timeout(config.apiTimeout)
				.then ->
					# Update the actual state.
					_.merge(actualState, stateDiff)
		)
		.catch (error) ->
			utils.mixpanelTrack('Device info update failure', { error, stateDiff })
			# Delay 5s before retrying a failed update
			Promise.delay(5000)
		.finally ->
			# Check if any more state diffs have appeared whilst we've been processing this update.
			applyState()

	exports.setUpdateState = (value) ->
		_.merge(updateState, value)

	exports.getState = ->
		fieldsToOmit = ['api_secret', 'logs_channel', 'provisioning_progress', 'provisioning_state']
		state = _.omit(targetState, fieldsToOmit)
		_.merge(state, updateState)
		return state

	# Calling this function updates the local device state, which is then used to synchronise
	# the remote device state, repeating any failed updates until successfully synchronised.
	# This function will also optimise updates by merging multiple updates and only sending the latest state.
	exports.updateState = (updatedState = {}, retry = false) ->
		# Remove any updates that match the last we successfully sent.
		_.merge(targetState, updatedState)

		# Only trigger applying state if an apply isn't already in progress.
		if !applyPromise.isPending()
			applyState()
		return

exports.getOSVersion = memoizePromise ->
	utils.getOSVersion(config.hostOsVersionPath)

exports.getConfig = ->
	knex('deviceConfig').select()
	.then ([ deviceConfig ]) ->
		return {
			values: JSON.parse(deviceConfig.values)
			targetValues: JSON.parse(deviceConfig.targetValues)
		}
exports.setConfig = (conf) ->
	confToUpdate = {}
	confToUpdate.values = JSON.stringify(conf.values) if conf.values?
	confToUpdate.targetValues = JSON.stringify(conf.targetValues) if conf.targetValues?
	knex('deviceConfig').update(confToUpdate)
