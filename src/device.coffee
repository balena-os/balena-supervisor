_ = require 'lodash'
Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
{ resinApi } = require './request'
device = exports
config = require './config'
configPath = '/boot/config.json'
request = Promise.promisifyAll(require('request'))
execAsync = Promise.promisify(require('child_process').exec)
fs = Promise.promisifyAll(require('fs'))
exports.getID = do ->
	deviceIdPromise = null
	return ->
		# We initialise the rejected promise just before we catch in order to avoid a useless first unhandled error warning.
		deviceIdPromise ?= Promise.rejected()
		# Only fetch the device id once (when successful, otherwise retry for each request)
		deviceIdPromise = deviceIdPromise.catch ->
			Promise.all([
				knex('config').select('value').where(key: 'apiKey')
				knex('config').select('value').where(key: 'uuid')
			])
			.spread ([{value: apiKey}], [{value: uuid}]) ->
				resinApi.get(
					resource: 'device'
					options:
						select: 'id'
						filter:
							uuid: uuid
					customOptions:
						apikey: apiKey
				)
			.then (devices) ->
				if devices.length is 0
					throw new Error('Could not find this device?!')
				return devices[0].id

rebootDevice = ->
	request.postAsync(config.gosuperAddress + '/v1/reboot')

exports.bootConfigEnvVarPrefix = bootConfigEnvVarPrefix = 'RESIN_HOST_CONFIG_'
bootBlockDevice = '/dev/mmcblk0p1'
bootMountPoint = '/mnt/root/boot'
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
	parsedEnv = _.pick env, (val, key) ->
		return _.startsWith(key, bootConfigEnvVarPrefix)
	parsedEnv = _.mapKeys parsedEnv, (val, key) ->
		key.replace(configRegex, '$2')
	parsedEnv = _.omit(parsedEnv, forbiddenConfigKeys)
	return parsedEnv

exports.setBootConfig = (env) ->
	device.getDeviceType()
	.then (deviceType) ->
		throw new Error('This is not a Raspberry Pi') if !_.startsWith(deviceType, 'raspberry-pi')
		Promise.join parseBootConfigFromEnv(env), fs.readFileAsync(bootConfigPath, 'utf8'), (configFromApp, configTxt ) ->
			throw new Error('No boot config to change') if _.isEmpty(configFromApp)
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
			keysFromFS = _.keys(configFromFS)
			toBeAdded = _.difference(keysFromApp, keysFromFS)
			toBeChanged = _.intersection(keysFromApp, keysFromFS)
			toBeChanged = _.filter toBeChanged, (key) ->
				configFromApp[key] != configFromFS[key]
			throw new Error('Nothing to change') if _.isEmpty(toBeChanged) and _.isEmpty(toBeAdded)
			# We add the keys to be added first so they are out of any filters
			outputConfig = _.map toBeAdded, (key) -> "#{key}=#{configFromApp[key]}"
			outputConfig = outputConfig.concat _.map configPositions, (key, index) ->
				configStatement = null
				if _.includes(toBeChanged, key)
					configStatement = "#{key}=#{configFromApp[key]}"
				else
					configStatement = configStatements[index]
				return configStatement
			# Here's the dangerous part:
			execAsync("mount -t vfat -o remount,rw #{bootBlockDevice} #{bootMountPoint}")
			.then ->
				fs.writeFileAsync(bootConfigPath + '.new', outputConfig.join('\n'))
			.then ->
				fs.renameAsync(bootConfigPath + '.new', bootConfigPath)
			.then ->
				execAsync('sync')
			.then ->
				rebootDevice()
	.catch (err) ->
		console.log('Will not set boot config: ', err)

exports.getDeviceType = do ->
	deviceTypePromise = null
	return ->
		deviceTypePromise ?= Promise.rejected()
		deviceTypePromise = deviceTypePromise.catch ->
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
		_.omit targetState, (value, key) ->
			actualState[key] is value

	applyState = ->
		stateDiff = getStateDiff()
		if _.size(stateDiff) is 0
			return
		applyPromise = Promise.join(
			knex('config').select('value').where(key: 'apiKey')
			device.getID()
			([{value: apiKey}], deviceID) ->
				stateDiff = getStateDiff()
				if _.size(stateDiff) is 0 || !apiKey?
					return
				resinApi.patch
					resource: 'device'
					id: deviceID
					body: stateDiff
					customOptions:
						apikey: apiKey
				.then ->
					# Update the actual state.
					_.merge(actualState, stateDiff)
		)
		.catch (error) ->
			utils.mixpanelTrack('Device info update failure', {error, stateDiff})
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

exports.getOSVersion = ->
	fs.readFileAsync(config.hostOsVersionPath)
	.then (releaseData) ->
		lines = (new String(releaseData)).split("\n")
		releaseItems = {}
		for line in lines
			[ key, val ] = line.split('=')
			releaseItems[_.trim(key)] = _.trim(val)
		# Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
		return releaseItems['PRETTY_NAME'].replace(/^"(.+(?="$))"$/, '$1')
	.catch (err) ->
		console.log("Could not get OS Version: ", err, err.stack)
		return undefined
