_ = require 'lodash'

exports.checkInt = checkInt = (s, options = {}) ->
	# Make sure `s` exists and is not an empty string.
	if !s
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
	if !s? or !_.isString(s) or s == 'null' or s == 'undefined' or s == ''
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
		isValidShortText(key) and /^[a-zA-Z_]+[a-zA-Z0-9_]*$/.test(key) and _.isString(val)

exports.isValidAppsObject = (obj) ->
	return false if !_.isObject(obj)
	return false if !_.every obj, (val, key) ->
		return false if !isValidShortText(key) or !checkInt(key)? # key is appId
		return false if !isValidShortText(val.name) or !isValidShortText(val.image) or !isValidShortText(val.commit) or !isValidEnv(val.config)
		if val.environment?
			return false if !isValidEnv(val.environment)
		return true
	return true

exports.isValidDependentDevicesObject = (devices) ->
	return false if !_.isObject(devices)
	return false if !_.every devices, (val, key) ->
		return false if !isValidShortText(key) # key is uuid
		return false if !isValidShortText(val.name)
		return false if !val.apps? or _.isEmpty(val.apps)
		return false if !_.every val.apps, (app) ->
			isValidEnv(app.config) and isValidEnv(app.environment)
		return true
	return true
