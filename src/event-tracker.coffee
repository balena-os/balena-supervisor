Promise = require 'bluebird'
_ = require 'lodash'
mixpanel = require 'mixpanel'

constants = require './lib/constants'

module.exports = class EventTracker
	constructor: ->
		@_client = null
		@_properties = null

	_logEvent: ->
		console.log(arguments)

	track: (ev, properties = {}) =>
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
				properties.app.env = JSON.stringify({})

		@_logEvent('Event:', ev, JSON.stringify(properties))
		return if !@_client?
		# Mutation is bad, and it should feel bad
		properties = _.assign(properties, @_properties)
		@_client.track(ev, properties)

	init: ({ offlineMode, mixpanelToken, uuid, mixpanelHost }) ->
		Promise.try =>
			@_properties =
				distinct_id: uuid
				uuid: uuid
			return if offlineMode
			@_client = mixpanel.init(mixpanelToken, { host: mixpanelHost })
