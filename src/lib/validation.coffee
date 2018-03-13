_ = require 'lodash'
debug = require('debug')('Resin-supervisor:validation')

exports.checkInt = checkInt = (s, options = {}) ->
	# Make sure `s` exists and is not an empty string.
	if !s?
		return
	i = parseInt(s, 10)
	if isNaN(i)
		return
	if options.positive && i <= 0
		return
	return i

exports.checkString = (s) ->
	# Make sure `s` exists and is not an empty string, or 'null' or 'undefined'.
	# This might happen if the parsing of config.json on the host using jq is wrong (it is buggy in some versions).
	if !s? or !_.isString(s) or s in [ 'null', 'undefined', '' ]
		return
	return s

exports.checkTruthy = (v) ->
	switch v
		when '1', 'true', true, 'on', 1 then true
		when '0', 'false', false, 'off', 0 then false
		else return

exports.isValidShortText = isValidShortText = (t) ->
	_.isString(t) and t.length <= 255

exports.isValidEnv = isValidEnv = (debug, obj) ->
	_.isObject(obj) and _.every obj, (val, key) ->
		isValidShortText(key) and /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) and _.isString(val)

exports.isValidLabelsObject = isValidLabelsObject = (debug, obj) ->
	if _.isObject(obj)
		debug('Labels object is not an object')
		return false
	return _.every obj, (val, key) ->
		res = isValidShortText(key) and /^[a-zA-Z][a-zA-Z0-9\.\-]*$/.test(key) and _.isString(val)
		if !res
			debug("Labels pair (#{key}, #{val}) did not pass validation")
		return res

undefinedOrValidEnv = (val) ->
	if val? and !isValidEnv(val)
		return false
	return true

exports.isValidDependentAppsObject = (apps) ->
	return false if !_.isObject(apps)
	return _.every apps, (val, appId) ->
		val = _.defaults(_.clone(val), { config: undefined, environment: undefined, commit: undefined, image: undefined })
		return false if !isValidShortText(appId) or !checkInt(appId)?
		return _.conformsTo(val, {
			name: isValidShortText
			image: (i) -> !val.commit? or isValidShortText(i)
			commit: (c) -> !c? or isValidShortText(c)
			config: undefinedOrValidEnv
			environment: undefinedOrValidEnv
		})

checkPred = (predicate, message, debug, input) ->
	res = predicate(input)
	if !res
		debug(message)
	return res

createPred = _.curry(checkPred)

isValidService = (debug, service, serviceId) ->
	if !isValidShortText(serviceId) or !checkInt(serviceId)
		debug("Service ID is not valid for service #{service}")
		return false

	return _.conformsTo(service, {
		serviceName: createPred(isValidShortText,
			"Service name is not valid for service #{service}",
			debug,
		)
		image: createPred(isValidShortText,
			"Image name is not valid for service #{service}",
			debug,
		)
		environment: createPred(_.partial(isValidEnv, debug),
			"Environment variables are not valid for service #{service}",
			debug,
		)
		imageId: createPred(
			(i) -> checkInt(i)?,
			"Image ID is not an integer for service #{service}",
			debug,
		)
		labels: createPred(_.partial(isValidLabelsObject, debug),
			"Labels object is not valid for service #{service}",
			debug,
		)
	})

exports.isValidAppsObject = (obj, debug = _.noop) ->
	if !_.isObject(obj)
		debug('Apps object is not an object!')
		return false

	return _.every obj, (val, appId) ->
		if !isValidShortText(appId) or !checkInt(appId)?
			debug('App id is not valid short text or integer')
			return false

		return _.conformsTo(_.defaults(_.clone(val), { releaseId: undefined }), {
			name: _.partial(checkPred, isValidShortText, 'Application name is not valid', debug)
			releaseId: _.partial(checkPred,
				(r) -> !r? or checkInt(r)?
				'Release ID is not null or an integer'
				debug
			)
			services: _.partial(checkPred,
				(s) -> _.isObject(s) and _.every(s, _.partial(isValidService, debug))
				'Services is not an object or a service is not valid'
				debug
			)
		})

exports.isValidDependentDevicesObject = (devices) ->
	return false if !_.isObject(devices)
	return _.every devices, (val, uuid) ->
		return false if !isValidShortText(uuid)
		return _.conformsTo(val, {
			name: isValidShortText
			apps: (a) ->
				return (
					_.isObject(a) and
					!_.isEmpty(a) and
					_.every a, (app) ->
						app = _.defaults(_.clone(app), { config: undefined, environment: undefined })
						_.conformsTo(app, { config: undefinedOrValidEnv, environment: undefinedOrValidEnv })
				)
		})

exports.validStringOrUndefined = (s) ->
	_.isUndefined(s) or (_.isString(s) and !_.isEmpty(s))
exports.validObjectOrUndefined = (o) ->
	_.isUndefined(o) or _.isObject(o)
