_ = require 'lodash'
path = require 'path'
{ checkTruthy, checkInt } = require '../lib/validation'
updateLock = require '../lib/update-lock'
constants = require '../lib/constants'
conversions =  require '../lib/conversions'

Duration = require 'duration-js'
Images = require './images'

validRestartPolicies = [ 'no', 'always', 'on-failure', 'unless-stopped' ]

parseMemoryNumber = (numAsString, defaultVal) ->
	m = numAsString?.toString().match(/^([0-9]+)([bkmg]?)$/)
	if !m? and defaultVal?
		return parseMemoryNumber(defaultVal)
	num = m[1]
	pow = { '': 0, 'b': 0, 'B': 0, 'K': 1, 'k': 1, 'm': 2, 'M': 2, 'g': 3, 'G': 3 }
	return parseInt(num) * 1024 ** pow[m[2]]

# Construct a restart policy based on its name.
# The default policy (if name is not a valid policy) is "always".
createRestartPolicy = (name) ->
	if not (name in validRestartPolicies)
		name = 'always'
	return { Name: name, MaximumRetryCount: 0 }

getCommand = (service, imageInfo) ->
	cmd = null
	if service.command?
		cmd = service.command
	else if imageInfo?.Config?.Cmd?
		cmd = imageInfo.Config.Cmd
	if _.isString(cmd)
		cmd = [ cmd ]
	return cmd

getEntrypoint = (service, imageInfo) ->
	entry = null
	if service.entrypoint?
		entry = service.entrypoint
	else if imageInfo?.Config?.Entrypoint?
		entry = imageInfo.Config.Entrypoint
	if _.isString(entry)
		entry = [ entry ]
	return entry

getStopSignal = (service, imageInfo) ->
	sig = null
	if service.stop_signal?
		sig = service.stop_signal
	else if imageInfo?.Config?.StopSignal?
		sig = imageInfo.Config.StopSignal
	if sig? and !_.isString(sig) # In case the YAML was parsed as a number
		sig = sig.toString()
	return sig

buildHealthcheckTest = (test) ->
	if _.isString(test)
		return [ 'CMD-SHELL', test ]
	else
		return test

getNanoseconds = (duration) ->
	d = new Duration(duration)
	return d.nanoseconds()

# Mutates imageHealthcheck
overrideHealthcheckFromCompose = (serviceHealthcheck, imageHealthcheck = {}) ->
	if serviceHealthcheck.disable
		imageHealthcheck.Test = [ 'NONE' ]
	else
		imageHealthcheck.Test = buildHealthcheckTest(serviceHealthcheck.test)
		if serviceHealthcheck.interval?
			imageHealthcheck.Interval = getNanoseconds(serviceHealthcheck.interval)
		if serviceHealthcheck.timeout?
			imageHealthcheck.Timeout = getNanoseconds(serviceHealthcheck.timeout)
		if serviceHealthcheck.start_period?
			imageHealthcheck.StartPeriod = getNanoseconds(serviceHealthcheck.start_period)
		if serviceHealthcheck.retries?
			imageHealthcheck.Retries = parseInt(serviceHealthcheck.retries)
	return imageHealthcheck

getHealthcheck = (service, imageInfo) ->
	healthcheck = null
	if imageInfo?.Config?.Healthcheck?
		healthcheck = imageInfo.Config.Healthcheck
	if service.healthcheck?
		healthcheck = overrideHealthcheckFromCompose(service.healthcheck, healthcheck)
	# Set invalid healthchecks back to null
	if healthcheck and (!healthcheck.Test? or _.isEqual(healthcheck.Test, []))
		healthcheck = null
	return healthcheck

killmePath = (appId, serviceName) ->
	return updateLock.lockPath(appId, serviceName)

defaultBinds = (appId, serviceName) ->
	return [
		"#{updateLock.lockPath(appId, serviceName)}:/tmp/resin"
	]

formatDevices = (devices) ->
	return _.map devices, (device) ->
		[ PathOnHost, PathInContainer, CgroupPermissions ] = device.split(':')
		PathInContainer ?= PathOnHost
		CgroupPermissions ?= 'rwm'
		return { PathOnHost, PathInContainer, CgroupPermissions }

# TODO: Support configuration for "networks"
module.exports = class Service
	constructor: (serviceProperties, opts = {}) ->
		{
			@image
			@expose
			@ports
			@networkMode
			@privileged
			@releaseId
			@imageId
			@serviceId
			@appId
			@serviceName
			@containerId
			@running
			@createdAt
			@environment
			@command
			@entrypoint
			@labels
			@volumes
			@restartPolicy
			@dependsOn
			@capAdd
			@capDrop
			@status
			@devices
			@exposedPorts
			@portBindings
			@networks

			@memLimit
			@memReservation
			@shmSize
			@cpuShares
			@cpuQuota
			@cpus
			@cpuset
			@nanoCpus
			@domainname
			@oomScoreAdj
			@dns
			@dnsSearch
			@dnsOpt
			@tmpfs
			@extraHosts
			@ulimits
			@ulimitsArray
			@stopSignal
			@stopGracePeriod
			@init
			@healthcheck
			@readOnly
			@sysctls
		} = _.mapKeys(serviceProperties, (v, k) -> _.camelCase(k))

		@networks ?= {}
		@privileged ?= false
		@volumes ?= []
		@labels ?= {}
		@environment ?= {}
		@running ?= true
		@ports ?= []
		@expose ?= []
		@capAdd ?= []
		@capDrop ?= []
		@devices ?= []
		@exposedPorts ?= {}
		@portBindings ?= {}

		@memLimit = parseMemoryNumber(@memLimit, '0')
		@memReservation = parseMemoryNumber(@memReservation, '0')
		@shmSize = parseMemoryNumber(@shmSize, '64m')
		@cpuShares ?= 0
		@cpuQuota ?= 0
		@cpus ?= 0
		@nanoCpus ?= 0
		@cpuset ?= ''
		@domainname ?= ''

		@oomScoreAdj ?= 0
		@tmpfs ?= []
		@extraHosts ?= []

		@dns ?= []
		@dnsSearch ?= []
		@dnsOpt ?= []
		@ulimitsArray ?= []

		@stopSignal ?= null
		@stopGracePeriod ?= null
		@healthcheck ?= null
		@init ?= null
		@readOnly ?= false

		@sysctls ?= {}

		# If the service has no containerId, it is a target service and has to be normalised and extended
		if !@containerId?
			@networkMode ?= 'default'
			if @networkMode not in [ 'host', 'bridge', 'none' ]
				@networkMode = "#{@appId}_#{@networkMode}"

			@networks = _.mapKeys @networks, (v, k) ->
				if k not in [ 'host', 'bridge', 'none' ]
					return "#{@appId}_#{k}"
				else
					return k

			@networks[@networkMode] ?= {}

			@restartPolicy = createRestartPolicy(serviceProperties.restart)
			@command = getCommand(serviceProperties, opts.imageInfo)
			@entrypoint = getEntrypoint(serviceProperties, opts.imageInfo)
			@stopSignal = getStopSignal(serviceProperties, opts.imageInfo)
			@healthcheck = getHealthcheck(serviceProperties, opts.imageInfo)
			@extendEnvVars(opts)
			@extendLabels(opts.imageInfo)
			@extendAndSanitiseVolumes(opts.imageInfo)
			@extendAndSanitiseExposedPorts(opts.imageInfo)
			{ @exposedPorts, @portBindings } = @getPortsAndPortBindings()
			@devices = formatDevices(@devices)
			@addFeaturesFromLabels(opts)
			if @dns?
				if !Array.isArray(@dns)
					@dns = [ @dns ]
			if @dnsSearch?
				if !Array.isArray(@dnsSearch)
					@dnsSearch = [ @dns ]

			@nanoCpus = Math.round(Number(@cpus) * 10 ** 9)

			@ulimitsArray = _.map @ulimits, (value, name) ->
				if _.isNumber(value) or _.isString(value)
					return { Name: name, Soft: checkInt(value), Hard: checkInt(value) }
				else
					return { Name: name, Soft: checkInt(value.soft), Hard: checkInt(value.hard) }
			if @init
				@init = true

			if @stopGracePeriod?
				d = new Duration(@stopGracePeriod)
				@stopGracePeriod = d.seconds()

			@readOnly = Boolean(@readOnly)

			if Array.isArray(@sysctls)
				@sysctls = _.fromPairs(_.map(@sysctls, (v) -> _.split(v, '=')))
			@sysctls = _.mapValues(@sysctls, String)

			# Avoid problems with yaml parsing numbers as strings
			for key in [ 'cpuShares', 'cpuQuota', 'oomScoreAdj' ]
				this[key] = checkInt(this[key])

	_addSupervisorApi: (opts) =>
		@environment['RESIN_SUPERVISOR_PORT'] = opts.listenPort.toString()
		@environment['RESIN_SUPERVISOR_API_KEY'] = opts.apiSecret
		if @networkMode == 'host'
			@environment['RESIN_SUPERVISOR_HOST'] = '127.0.0.1'
			@environment['RESIN_SUPERVISOR_ADDRESS'] = "http://127.0.0.1:#{opts.listenPort}"
		else
			@environment['RESIN_SUPERVISOR_HOST'] = opts.supervisorApiHost
			@environment['RESIN_SUPERVISOR_ADDRESS'] = "http://#{opts.supervisorApiHost}:#{opts.listenPort}"
			@networks[constants.supervisorNetworkInterface] = {}

	addFeaturesFromLabels: (opts) =>
		if checkTruthy(@labels['io.resin.features.dbus'])
			@volumes.push('/run/dbus:/host/run/dbus')
		if checkTruthy(@labels['io.resin.features.kernel_modules'])
			@volumes.push('/lib/modules:/lib/modules')
		if checkTruthy(@labels['io.resin.features.firmware'])
			@volumes.push('/lib/firmware:/lib/firmware')
		if checkTruthy(@labels['io.resin.features.supervisor_api'])
			@_addSupervisorApi(opts)
		else
			# We ensure the user hasn't added "supervisor0" to the service's networks
			delete @networks[constants.supervisorNetworkInterface]
		if checkTruthy(@labels['io.resin.features.resin_api'])
			@environment['RESIN_API_KEY'] = opts.deviceApiKey

	extendEnvVars: ({ imageInfo, uuid, appName, name, version, deviceType, osVersion }) =>
		newEnv =
			RESIN_APP_ID: @appId.toString()
			RESIN_APP_NAME: appName
			RESIN_SERVICE_NAME: @serviceName
			RESIN_DEVICE_UUID: uuid
			RESIN_DEVICE_NAME_AT_INIT: name
			RESIN_DEVICE_TYPE: deviceType
			RESIN_HOST_OS_VERSION: osVersion
			RESIN_SUPERVISOR_VERSION: version
			RESIN_APP_LOCK_PATH: '/tmp/resin/resin-updates.lock'
			RESIN_SERVICE_KILL_ME_PATH: '/tmp/resin/resin-kill-me'
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
		@labels['io.resin.app_id'] = @appId.toString()
		@labels['io.resin.service_id'] = @serviceId.toString()
		@labels['io.resin.service_name'] = @serviceName
		return @labels

	extendAndSanitiseExposedPorts: (imageInfo) =>
		@expose = _.clone(@expose)
		@expose = _.map(@expose, String)
		if imageInfo?.Config?.ExposedPorts?
			for own k, v of imageInfo.Config.ExposedPorts
				port = k.match(/^([0-9]*)\/tcp$/)?[1]
				if port? and !_.find(@expose, port)
					@expose.push(port)

		return @expose

	extendAndSanitiseVolumes: (imageInfo) =>
		volumes = []
		for vol in @volumes
			isBind = /:/.test(vol)
			if isBind
				[ bindSource, bindDest ] = vol.split(':')
				if !path.isAbsolute(bindSource)
					# Rewrite named volumes to namespace by appId
					volumes.push("#{@appId}_#{bindSource}:#{bindDest}")
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
			if _.includes(defaults, vol) or !/:/.test(vol)
				return null
			bindSource = vol.split(':')[0]
			if !path.isAbsolute(bindSource)
				return bindSource.split('_')[1]
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
			status = 'Running'
		else if container.State.Status == 'created'
			status = 'Installed'
		else
			status = 'Stopped'

		boundContainerPorts = []
		ports = []
		expose = []
		for own port, conf of container.HostConfig.PortBindings
			containerPort = port.match(/^([0-9]*)\/tcp$/)?[1]
			if containerPort?
				boundContainerPorts.push(containerPort)
				hostPort = conf[0]?.HostPort
				if !_.isEmpty(hostPort)
					ports.push("#{hostPort}:#{containerPort}")
				else
					ports.push(containerPort)
		for own port, conf of container.Config.ExposedPorts
			containerPort = port.match(/^([0-9]*)\/tcp$/)?[1]
			if containerPort? and !_.includes(boundContainerPorts, containerPort)
				expose.push(containerPort)

		appId = checkInt(container.Config.Labels['io.resin.app_id'])
		serviceId = checkInt(container.Config.Labels['io.resin.service_id'])
		serviceName = container.Config.Labels['io.resin.service_name']
		nameComponents = container.Name.match(/.*_(\d+)_(\d+)$/)
		imageId = checkInt(nameComponents?[1])
		releaseId = checkInt(nameComponents?[2])
		service = {
			appId: appId
			serviceId: serviceId
			serviceName: serviceName
			imageId: imageId
			command: container.Config.Cmd
			entrypoint: container.Config.Entrypoint
			networkMode: container.HostConfig.NetworkMode
			volumes: _.concat(container.HostConfig.Binds ? [], _.keys(container.Config.Volumes ? {}))
			image: container.Config.Image
			environment: conversions.envArrayToObject(container.Config.Env)
			privileged: container.HostConfig.Privileged
			releaseId: releaseId
			labels: container.Config.Labels
			running: container.State.Running
			createdAt: new Date(container.Created)
			restartPolicy: container.HostConfig.RestartPolicy
			ports: ports
			expose: expose
			containerId: container.Id
			capAdd: container.HostConfig.CapAdd
			capDrop: container.HostConfig.CapDrop
			devices: container.HostConfig.Devices
			status
			exposedPorts: container.Config.ExposedPorts
			portBindings: container.HostConfig.PortBindings
			networks: container.NetworkSettings.Networks
			memLimit: container.HostConfig.Memory
			memReservation: container.HostConfig.MemoryReservation
			shmSize: container.HostConfig.ShmSize
			cpuShares: container.HostConfig.CpuShares
			cpuQuota: container.HostConfig.CpuQuota
			nanoCpus: container.HostConfig.NanoCpus
			cpuset: container.HostConfig.CpusetCpus
			domainname: container.Config.Domainname
			oomScoreAdj: container.HostConfig.OomScoreAdj
			dns: container.HostConfig.Dns
			dnsSearch: container.HostConfig.DnsSearch
			dnsOpt: container.HostConfig.DnsOpt
			tmpfs: _.keys(container.HostConfig.Tmpfs ? {})
			extraHosts: container.HostConfig.ExtraHosts
			ulimitsArray: container.HostConfig.Ulimits
			stopSignal: container.Config.StopSignal
			stopGracePeriod: container.Config.StopTimeout
			healthcheck: container.Config.Healthcheck
			init: container.HostConfig.Init
			readOnly: container.HostConfig.ReadonlyRootfs
			sysctls: container.HostConfig.Sysctls
		}
		# I've seen docker use either 'no' or '' for no restart policy, so we normalise to 'no'.
		if service.restartPolicy.Name == ''
			service.restartPolicy.Name = 'no'
		return new Service(service)

	# TODO: map ports for any of the possible formats "container:host/protocol", port ranges, etc.
	getPortsAndPortBindings: =>
		exposedPorts = {}
		portBindings = {}
		if @ports?
			for port in @ports
				[ hostPort, containerPort ] = port.toString().split(':')
				containerPort ?= hostPort
				exposedPorts[containerPort + '/tcp'] = {}
				portBindings[containerPort + '/tcp'] = [ { HostIp: '', HostPort: hostPort } ]
		if @expose?
			for port in @expose
				exposedPorts[port + '/tcp'] = {}
		return { exposedPorts, portBindings }

	getBindsAndVolumes: =>
		binds = []
		volumes = {}
		for vol in @volumes
			isBind = /:/.test(vol)
			if isBind
				binds.push(vol)
			else
				volumes[vol] = {}
		return { binds, volumes }

	toContainerConfig: =>
		{ binds, volumes } = @getBindsAndVolumes()
		tmpfs = {}
		for dir in @tmpfs
			tmpfs[dir] = ''
		conf = {
			name: "#{@serviceName}_#{@imageId}_#{@releaseId}"
			Image: @image
			Cmd: @command
			Entrypoint: @entrypoint
			Tty: true
			Volumes: volumes
			Env: _.map @environment, (v, k) -> k + '=' + v
			ExposedPorts: @exposedPorts
			Labels: @labels
			Domainname: @domainname
			HostConfig:
				Memory: @memLimit
				MemoryReservation: @memReservation
				ShmSize: @shmSize
				Privileged: @privileged
				NetworkMode: @networkMode
				PortBindings: @portBindings
				Binds: binds
				CapAdd: @capAdd
				CapDrop: @capDrop
				Devices: @devices
				CpuShares: @cpuShares
				NanoCpus: @nanoCpus
				CpuQuota: @cpuQuota
				CpusetCpus: @cpuset
				OomScoreAdj: @oomScoreAdj
				Tmpfs: tmpfs
				Dns: @dns
				DnsSearch: @dnsSearch
				DnsOpt: @dnsOpt
				Ulimits: @ulimitsArray
				ReadonlyRootfs: @readOnly
				Sysctls: @sysctls
		}
		if @stopSignal?
			conf.StopSignal = @stopSignal
		if @stopGracePeriod?
			conf.StopTimeout = @stopGracePeriod
		if @healthcheck?
			conf.Healthcheck = @healthcheck
		if @restartPolicy.Name != 'no'
			conf.HostConfig.RestartPolicy = @restartPolicy
		# If network mode is the default network for this app, add alias for serviceName
		if @networkMode == "#{@appId}_default"
			conf.NetworkingConfig = {
				EndpointsConfig: {
					"#{@appId}_default": {
						Aliases: [ @serviceName ]
					}
				}
			}
		if @init
			conf.HostConfig.Init = true
		return conf

	# TODO: when we support network configuration properly, return endpointConfig: conf
	extraNetworksToJoin: =>
		_.map _.pickBy(@networks, (conf, net) => net != @networkMode), (conf, net) ->
			return { name: net, endpointConfig: {} }

	# TODO: compare configuration, not only network names
	hasSameNetworks: (otherService) =>
		_.isEmpty(_.xor(_.keys(@networks), _.keys(otherService.networks)))

	isSameContainer: (otherService) =>
		propertiesToCompare = [
			'command'
			'entrypoint'
			'networkMode'
			'privileged'
			'restartPolicy'
			'labels'
			'environment'
			'portBindings'
			'exposedPorts'
			#'memLimit'
			#'memReservation'
			'shmSize'
			'cpuShares'
			'cpuQuota'
			'nanoCpus'
			'cpuset'
			'domainname'
			'oomScoreAdj'
			'healthcheck'
			'stopSignal'
			'stopGracePeriod'
			'init'
			'readOnly'
			'sysctls'
		]
		arraysToCompare = [
			'volumes'
			'devices'
			'capAdd'
			'capDrop'
			'dns'
			'dnsSearch'
			'dnsOpt'
			'tmpfs'
			'extraHosts'
			'ulimitsArray'
		]
		isEq = Images.isSameImage({ name: @image }, { name: otherService.image }) and
			_.isEqual(_.pick(this, propertiesToCompare), _.pick(otherService, propertiesToCompare)) and
			@hasSameNetworks(otherService) and
			_.every arraysToCompare, (property) =>
				_.isEmpty(_.xorWith(this[property], otherService[property], _.isEqual))

		# This can be very useful for debugging so I'm leaving it commented for now.
		# Uncomment to see the services whenever they don't match.
		#if !isEq
		#	console.log(JSON.stringify(this, null, 2))
		#	console.log(JSON.stringify(otherService, null, 2))
		#	diff = _.omitBy this, (prop, k) -> _.isEqual(prop, otherService[k])
		#	console.log(JSON.stringify(diff, null, 2))

		return isEq

	isEqual: (otherService) =>
		return @isSameContainer(otherService) and
			@running == otherService.running and
			@releaseId == otherService.releaseId and
			@imageId == otherService.imageId
