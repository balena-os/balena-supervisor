mixpanel = require 'mixpanel'
constants = require './constants'
mixpanelClient = null
mixpanelProperties = null

exports.track = (ev, properties = {}) ->
	# Allow passing in an error directly and having it assigned to the error property.
	if properties instanceof Error
		properties = error: properties

	# If the properties has an error argument that is an Error object then it treats it nicely,
	# rather than letting it become `{}`
	if properties.error instanceof Error
		properties.error =
			message: properties.error.message
			stack: properties.error.stack

	properties = _.cloneDeep(properties)

	# Don't log private env vars (e.g. api keys)
	if properties?.app?.env?
		try
			{ env } = properties.app
			env = JSON.parse(env) if _.isString(env)
			safeEnv = _.omit(env, constants.privateAppEnvVars)
			properties.app.env = JSON.stringify(safeEnv)
		catch
			properties.app.env = 'Fully hidden due to error in selective hiding'

	console.log('Event:', ev, JSON.stringify(properties))
	return if !mixpanelClient?
	# Mutation is bad, and it should feel bad
	properties = _.assign(properties, mixpanelProperties)
	mixpanelClient.track(ev, properties)

exports.init = ({ offlineMode, mixpanelToken, username, uuid }) ->
	return if offlineMode
	mixpanelClient = mixpanel.init(mixpanelToken)
	mixpanelProperties =
		distinct_id: uuid
		uuid: uuid
		username: username
