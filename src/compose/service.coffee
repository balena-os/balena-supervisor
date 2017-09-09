_ = require 'lodash'
path = require 'path'
{ checkTruthy } = require '../lib/validation'
updateLock = require '../lib/update-lock'
constants = require '../lib/constants'
conversions =  require '../lib/conversions'

validRestartPolicies = [ 'no', 'always', 'on-failure', 'unless-stopped' ]

# Construct a restart policy based on its name.
# The default policy (if name is not a valid policy) is "always".
createRestartPolicy = (name) ->
	if not (name in validRestartPolicies)
		name = 'unless-stopped'
	return { Name: name, MaximumRetryCount: 0 }

getCommand = (service, imageInfo) ->
	if service.command?
		return service.command
	else if imageInfo?.Config?.Cmd
		return imageInfo.Config.Cmd

getEntrypoint = (service, imageInfo) ->
	if service.entrypoint?
		return service.entrypoint
	else if imageInfo?.Config?.Entrypoint
		return imageInfo.Config.Entrypoint

killmePath = (appId, serviceName) ->
	return "/tmp/resin-supervisor/services/#{appId}/#{serviceName}"

defaultBinds = (appId, serviceName) ->
	return [
		"#{updateLock.lockPath(appId)}:/tmp/resin"
		"#{killmePath(appId, serviceName)}:/tmp/resin-service"
	]

module.exports = class Service
	constructor: (serviceProperties, opts = {}) ->
		{
			@image
			@expose
			@ports
			@network_mode
			@privileged
			@releaseId
			@imageId
			@serviceId
			@appId
			@serviceName
			@containerId
			@status
			@running
			@createdAt
			@environment
			@command
			@entrypoint
			@labels
			@volumes
			@restartPolicy
			@depends_on
			@cap_add
			@cap_drop
			@commit
		} = serviceProperties
		@privileged ?= false
		@volumes ?= []
		@labels ?= {}
		@environment ?= {}
		@running ?= true
		@ports ?= []
		@expose ?= []
		@cap_add ?= []
		@cap_drop ?= []

		# If the service has no containerId, it is a target service and has to be normalised and extended
		if !@containerId?
			@restartPolicy = createRestartPolicy(serviceProperties.restart)
			@command = getCommand(serviceProperties, opts.imageInfo)
			@entrypoint = getEntrypoint(serviceProperties, opts.imageInfo)
			@extendEnvVars(opts)
			@extendLabels(opts.imageInfo)
			@extendAndSanitiseVolumes(opts.imageInfo)

			if checkTruthy(@labels['io.resin.features.dbus'])
				@volumes.push('/run/dbus:/host/run/dbus')
			if checkTruthy(@labels['io.resin.features.kernel_modules'])
				@volumes.push('/lib/modules:/lib/modules')
			if checkTruthy(@labels['io.resin.features.firmware'])
				@volumes.push('/lib/firmware:/lib/firmware')
			if checkTruthy(@labels['io.resin.features.supervisor_api'])
				@environment['RESIN_SUPERVISOR_HOST'] = opts.supervisorApiHost
				@environment['RESIN_SUPERVISOR_PORT'] = opts.listenPort.toString()
				@environment['RESIN_SUPERVISOR_ADDRESS'] = "http://#{opts.supervisorApiHost}:#{opts.listenPort}"
				@environment['RESIN_SUPERVISOR_API_KEY'] = opts.apiSecret
			if checkTruthy(@labels['io.resin.features.resin_api'])
				@environment['RESIN_API_KEY'] = opts.deviceApiKey

	extendEnvVars: ({ imageInfo, uuid, appName, commit, name, version, deviceType, osVersion }) =>
		newEnv =
			RESIN_APP_ID: @appId.toString()
			RESIN_APP_NAME: appName
			RESIN_APP_COMMIT: commit
			RESIN_APP_RELEASE: @releaseId
			RESIN_SERVICE_NAME: @serviceName
			RESIN_DEVICE_UUID: uuid
			RESIN_DEVICE_NAME_AT_INIT: name
			RESIN_DEVICE_TYPE: deviceType
			RESIN_HOST_OS_VERSION: osVersion
			RESIN_SUPERVISOR_VERSION: version
			RESIN_APP_LOCK_PATH: '/tmp/resin/resin-updates.lock'
			RESIN_SERVICE_KILL_ME_PATH: '/tmp/resin-service/resin-kill-me'
			RESIN: '1'
			USER: 'root'
		if @environment?
			_.defaults(newEnv, @environment)
		_.defaults(newEnv, conversions.envArrayToObject(imageInfo?.Config?.Env ? []))
		@environment = newEnv
		return @environment

	extendLabels: (imageInfo) =>
		@labels = _.clone(@labels)
		_.defaults(@labels, imageInfo?.Config?.Labels ? {})
		@labels['io.resin.supervised'] = 'true'
		@labels['io.resin.app_id'] = @appId
		@labels['io.resin.service_id'] = @serviceId
		@labels['io.resin.service_name'] = @serviceName
		@labels['io.resin.image_id'] = @imageId
		@labels['io.resin.release_id'] = @releaseId
		@labels['io.resin.commit'] = @commit
		return @labels

	extendAndSanitiseVolumes: (imageInfo) =>
		volumes = []
		_.forEach @volumes, (vol) ->
			isBind = /:/.test(vol)
			if isBind
				bindSource = vol.split(':')[0]
				if !path.isAbsolute(bindSource)
					volumes.push(vol)
				else
					console.log("Ignoring invalid bind mount #{vol}")
			else
				volumes.push(vol)
		volumes = volumes.concat(@defaultBinds())
		volumes = _.union(_.keys(imageInfo?.Config?.Volumes), volumes)
		@volumes = volumes
		return @volumes

	getNamedVolumes: =>
		defaults = @defaultBinds()
		validVolumes = _.map @volumes, (vol) ->
			return null if _.includes(defaults, vol)
			return null if !/:/.test(vol)
			bindSource = vol.split(':')[0]
			if !path.isAbsolute(bindSource)
				return bindSource
			else
				return null
		return _.filter(validVolumes, (v) -> !_.isNull(v))

	lockPath: =>
		return updateLock.lockPath(@appId)

	killmePath: =>
		return killmePath(@appId, @serviceName)

	killmeFullPathOnHost: =>
		return "#{constants.rootMountPoint}#{@killmePath()}/resin-kill-me"

	defaultBinds: ->
		return defaultBinds(@appId, @serviceName)

	@fromContainer: (container) ->
		if container.State.Running
			state = 'Idle'
		else
			state = 'Stopped'

		boundContainerPorts = []
		ports = []
		expose = []
		_.forEach container.HostConfig.PortBindings, (conf, port) ->
			containerPort = port.match(/^([0-9]*)\/tcp$/)?[1]
			if containerPort?
				boundContainerPorts.push(containerPort)
				hostPort = conf[0]?.HostPort
				if !_.isEmpty(hostPort)
					ports.push("#{containerPort}:#{hostPort}")
				else
					ports.push(containerPort)
		_.forEach container.Config.ExposedPorts, (_, port) ->
			containerPort = port.match(/^([0-9]*)\/tcp$/)?[1]
			if containerPort? and !_.includes(boundContainerPorts, containerPort)
				expose.push(containerPort)

		appId = container.Config.Labels['io.resin.app_id']
		serviceId = container.Config.Labels['io.resin.service_id']
		serviceName = container.Config.Labels['io.resin.service_name']
		service = {
			appId: appId
			serviceId: serviceId
			serviceName: serviceName
			imageId: container.Config.Labels['io.resin.image_id']
			command: container.Config.Cmd
			entrypoint: container.Config.Entrypoint
			network_mode: container.HostConfig.NetworkMode
			volumes: _.concat(container.HostConfig.Binds ? [], _.keys(container.Config.Volumes ? {}))
			image: container.Config.Image
			environment: conversions.envArrayToObject(container.Config.Env)
			privileged: container.HostConfig.Privileged
			releaseId: container.Config.Labels['io.resin.release_id']
			commit: container.Config.Labels['io.resin.commit']
			labels: container.Config.Labels
			status: {
				state
				download_progress: null
			}
			running: container.State.Running
			createdAt: new Date(container.Created)
			restartPolicy: container.HostConfig.RestartPolicy
			ports: ports
			expose: expose
			containerId: container.Id
			cap_add: container.HostConfig.CapAdd
			cap_drop: container.HostConfig.CapDrop
		}
		return new Service(service)

	# TODO: map ports for any of the possible formats "container:host/protocol", port ranges, etc.
	getPortsAndPortBindings: =>
		ports = {}
		portBindings = {}
		if @ports?
			_.forEach @ports, (port) ->
				ports[port + '/tcp'] = {}
				portBindings[port + '/tcp'] = [ HostPort: port ]
		if @expose?
			_.forEach @expose, (port) ->
				ports[port + '/tcp'] = {}
		return { ports, portBindings }

	getBindsAndVolumes: =>
		binds = []
		volumes = {}
		_.forEach @volumes, (vol) ->
			isBind = /:/.test(vol)
			if isBind
				binds.push(vol)
			else
				volumes[vol] = {}
		return { binds, volumes }

	toContainerConfig: =>
		{ ports, portBindings } = @getPortsAndPortBindings()
		{ binds, volumes } = @getBindsAndVolumes()

		conf = {
			Image: @image
			Cmd: @command
			Entrypoint: @entrypoint
			Tty: true
			Volumes: volumes
			Env: _.map @environment, (v, k) -> k + '=' + v
			ExposedPorts: ports
			Labels: @labels
			HostConfig:
				Privileged: @privileged
				NetworkMode: @network_mode
				PortBindings: portBindings
				Binds: binds
				RestartPolicy: @restartPolicy
				CapAdd: @cap_add
				CapDrop: @cap_drop
		}
		return conf

	isSameContainer: (otherService) =>
		propertiesToCompare = [
			'image'
			'releaseId'
			'imageId'
			'network_mode'
			'privileged'
			'restartPolicy'
			'labels'
			'environment'
			'cap_add'
			'cap_drop'
		]
		arraysToCompare = [
			'ports'
			'expose'
			'volumes'
		]
		return _.isEqual(_.pick(this, propertiesToCompare), _.pick(otherService, propertiesToCompare)) and
			_.every arraysToCompare, (property) =>
				_.isEmpty(_.difference(this[property], otherService[property])) and
					_.isEmpty(_.difference(otherService[property], this[property]))

	isEqual: (otherService) =>
		return @isSameContainer(otherService) and @running == otherService.running
