_ = require 'lodash'

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
exports.isValidEnv = isValidEnv = (obj) ->
	_.isObject(obj) and _.every obj, (val, key) ->
		isValidShortText(key) and /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) and _.isString(val)

exports.isValidLabelsObject = isValidLabelsObject = (obj) ->
	_.isObject(obj) and _.every obj, (val, key) ->
		isValidShortText(key) and /^[a-zA-Z][a-zA-Z0-9\.\-]*$/.test(key) and _.isString(val)

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

isValidService = (service, serviceId) ->
	return false if !isValidShortText(serviceId) or !checkInt(serviceId)
	return _.conformsTo(service, {
		serviceName: isValidShortText
		image: isValidShortText
		environment: isValidEnv
		imageId: (i) -> checkInt(i)?
		labels: isValidLabelsObject
	})

exports.isValidAppsObject = (obj) ->
	return false if !_.isObject(obj)
	return _.every obj, (val, appId) ->
		return false if !isValidShortText(appId) or !checkInt(appId)?
		return _.conformsTo(_.defaults(_.clone(val), { releaseId: undefined }), {
			name: isValidShortText
			releaseId: (r) -> !r? or checkInt(r)?
			services: (s) -> _.isObject(s) and _.every(s, isValidService)
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
