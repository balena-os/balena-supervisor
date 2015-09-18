_ = require 'lodash'
Promise = require 'bluebird'
knex = require './db'
utils = require './utils'
{ resinApi } = require './request'
device = exports
configPath = '/boot/config.json'

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

# Calling this function updates the local device state, which is then used to synchronise
# the remote device state, repeating any failed updates until successfully synchronised.
# This function will also optimise updates by merging multiple updates and only sending the latest state.
exports.updateState = do ->
	applyPromise = Promise.resolve()
	targetState = {}
	actualState = {}

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

	return (updatedState = {}, retry = false) ->
		# Remove any updates that match the last we successfully sent.
		_.merge(targetState, updatedState)

		# Only trigger applying state if an apply isn't already in progress.
		if !applyPromise.isPending()
			applyState()
		return
