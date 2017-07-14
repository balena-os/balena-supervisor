gosuper = require './lib/gosuper'

exports.reboot = ->
	gosuper.postAsync('/v1/reboot')

# TODO: move to APIBinder
do ->
	APPLY_STATE_SUCCESS_DELAY = 1000
	APPLY_STATE_RETRY_DELAY = 5000
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
			utils.getConfig('apiKey')
			device.getID()
			(apiKey, deviceID) ->
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
		.delay(APPLY_STATE_SUCCESS_DELAY)
		.catch (error) ->
			mixpanel.track('Device info update failure', { error, stateDiff })
			# Delay 5s before retrying a failed update
			Promise.delay(APPLY_STATE_RETRY_DELAY)
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
