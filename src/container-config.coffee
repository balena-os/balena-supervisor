Promise = require 'bluebird'
constants = require './constants'
_ = require 'lodash'

exports.extendEnvVars = (env, { uuid, appId, appName, commit, listenPort, name, apiSecret, deviceApiKey, version, deviceType, osVersion }) ->
	host = '127.0.0.1'
	newEnv =
		RESIN_APP_ID: appId.toString()
		RESIN_APP_NAME: appName
		RESIN_APP_RELEASE: commit
		RESIN_DEVICE_UUID: uuid
		RESIN_DEVICE_NAME_AT_INIT: name
		RESIN_DEVICE_TYPE: deviceType
		RESIN_HOST_OS_VERSION: osVersion
		RESIN_SUPERVISOR_ADDRESS: "http://#{host}:#{listenPort}"
		RESIN_SUPERVISOR_HOST: host
		RESIN_SUPERVISOR_PORT: listenPort.toString()
		RESIN_SUPERVISOR_API_KEY: apiSecret
		RESIN_SUPERVISOR_VERSION: version
		RESIN_API_KEY: deviceApiKey
		RESIN: '1'
		USER: 'root'
	if env?
		_.defaults(newEnv, env)
	return Promise.props(newEnv)

exports.defaultVolumes = (includeV1Volumes) ->
	volumes = {
		'/data': {}
		'/lib/modules': {}
		'/lib/firmware': {}
		'/host/run/dbus': {}
	}
	if includeV1Volumes
		volumes['/host/var/lib/connman'] = {}
		volumes['/host_run/dbus'] = {}
	return volumes

getDataPath = (identifier) ->
	return constants.dataPath + '/' + identifier

exports.defaultBinds = (dataPath, includeV1Binds) ->
	binds = [
		getDataPath(dataPath) + ':/data'
		"/tmp/resin-supervisor/#{dataPath}:/tmp/resin"
		'/lib/modules:/lib/modules'
		'/lib/firmware:/lib/firmware'
		'/run/dbus:/host/run/dbus'
	]
	if includeV1Binds
		binds.push('/run/dbus:/host_run/dbus')
		binds.push('/var/lib/connman:/host/var/lib/connman')
	return binds
