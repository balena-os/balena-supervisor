_ = require 'lodash'
path = require 'path'
os = require 'os'
{ checkTruthy, checkInt } = require '../lib/validation'
updateLock = require '../lib/update-lock'
constants = require '../lib/constants'
conversions =  require '../lib/conversions'
parseCommand = require('shell-quote').parse
Duration = require 'duration-js'

validRestartPolicies = [ 'no', 'always', 'on-failure', 'unless-stopped' ]

# Adapted from https://github.com/docker/docker-py/blob/master/docker/utils/ports.py#L3
PORTS_REGEX = /^(?:(?:([a-fA-F\d.:]+):)?([\d]*)(?:-([\d]+))?:)?([\d]+)(?:-([\d]+))?(?:\/(udp|tcp))?$/

parseMemoryNumber = (numAsString, defaultVal) ->
	m = numAsString?.toString().match(/^([0-9]+)([bkmg]?)b?$/i)
	if !m? and defaultVal?
		return parseMemoryNumber(defaultVal)
	num = m[1]
	pow = { '': 0, 'b': 0, 'B': 0, 'K': 1, 'k': 1, 'm': 2, 'M': 2, 'g': 3, 'G': 3 }
	return parseInt(num) * 1024 ** pow[m[2]]

# Construct a restart policy based on its name.
# The default policy (if name is not a valid policy) is "always".
createRestartPolicy = (name) ->
	if name not in validRestartPolicies
		name = 'always'
	return { Name: name, MaximumRetryCount: 0 }

processCommandStr = (s) ->
	# Escape dollars
	s.replace(/(\$)/g, '\\$1')

processCommandParsedArrayElement = (arg) ->
	if _.isObject(arg)
		if arg.op == 'glob'
			return arg.pattern
		return arg.op
	return arg

ensureCommandIsArray = (s) ->
	if _.isString(s)
		s = _.map(parseCommand(processCommandStr(s)), processCommandParsedArrayElement)
	return s

getCommand = (service, imageInfo) ->
	cmd = service.command ? imageInfo?.Config?.Cmd ? null
	return ensureCommandIsArray(cmd)

getEntrypoint = (service, imageInfo) ->
	entry = service.entrypoint ? imageInfo?.Config?.Entrypoint ? null
	return ensureCommandIsArray(entry)

getStopSignal = (service, imageInfo) ->
	sig = service.stopSignal ? imageInfo?.Config?.StopSignal ? null
	if sig? and !_.isString(sig) # In case the YAML was parsed as a number
		sig = sig.toString()
	return sig

getUser = (service, imageInfo) ->
	return service.user ? imageInfo?.Config?.User ? ''

getWorkingDir = (service, imageInfo) ->
	return service.workingDir ? imageInfo?.Config?.WorkingDir ? ''

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
	healthcheck = imageInfo?.Config?.Healthcheck ? null
	if service.healthcheck?
		healthcheck = overrideHealthcheckFromCompose(service.healthcheck, healthcheck)
	# Set invalid healthchecks back to null
	if healthcheck? and (!healthcheck.Test? or _.isEqual(healthcheck.Test, []))
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
	constructor: (props, opts = {}) ->
		serviceProperties = _.mapKeys(props, (v, k) -> _.camelCase(k))
		{
			@image
			@imageName
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
			@oomKillDisable
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
			@hostname
			@cgroupParent
			@groupAdd
			@pid
			@pidsLimit
			@securityOpt
			@storageOpt
			@usernsMode
			@ipc
			@macAddress
			@user
			@workingDir
		} = serviceProperties

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
		@oomKillDisable ?= false
		@tmpfs ?= []
		@extraHosts ?= []

		@dns ?= []
		@dnsSearch ?= []
		@dnsOpt ?= []
		@ulimitsArray ?= []
		@groupAdd ?= []

		@stopSignal ?= null
		@stopGracePeriod ?= null
		@healthcheck ?= null
		@init ?= null
		@readOnly ?= false
		@macAddress ?= null

		@sysctls ?= {}

		@hostname ?= ''
		@cgroupParent ?= ''
		@pid ?= ''
		@pidsLimit ?= 0
		@securityOpt ?= []
		@storageOpt ?= {}
		@usernsMode ?= ''
		@user ?= ''
		@workingDir ?= ''

		if _.isEmpty(@ipc)
			@ipc = 'shareable'

		# If the service has no containerId, it is a target service and has to be normalised and extended
		if !@containerId?
			if !@networkMode?
				if !_.isEmpty(@networks)
					@networkMode = _.keys(@networks)[0]
				else
					@networkMode = 'default'
			if @networkMode not in [ 'host', 'bridge', 'none' ]
				@networkMode = "#{@appId}_#{@networkMode}"

			@networks = _.mapKeys @networks, (v, k) =>
				if k not in [ 'host', 'bridge', 'none' ]
					return "#{@appId}_#{k}"
				return k

			if @networkMode == 'host' and @hostname == ''
				@hostname = opts.hostnameOnHost

			@networks[@networkMode] ?= {}

			@restartPolicy = createRestartPolicy(serviceProperties.restart)
			@command = getCommand(serviceProperties, opts.imageInfo)
			@entrypoint = getEntrypoint(serviceProperties, opts.imageInfo)
			@stopSignal = getStopSignal(serviceProperties, opts.imageInfo)
			@healthcheck = getHealthcheck(serviceProperties, opts.imageInfo)
			@workingDir = getWorkingDir(serviceProperties, opts.imageInfo)
			@user = getUser(serviceProperties, opts.imageInfo)
			@extendEnvVars(opts)
			@extendLabels(opts.imageInfo)
			@extendAndSanitiseVolumes(opts.imageInfo)
			@extendAndSanitiseExposedPorts(opts.imageInfo)
			{ @exposedPorts, @portBindings } = @getPortsAndPortBindings()
			@devices = formatDevices(@devices)
			@addFeaturesFromLabels(opts)
			if @dns?
				@dns = _.castArray(@dns)
			if @dnsSearch?
				@dnsSearch = _.castArray(@dnsSearch)
			if @tmpfs?
				@tmpfs = _.castArray(@tmpfs)

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

			@oomKillDisable = Boolean(@oomKillDisable)
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
		if checkTruthy(@labels['io.resin.features.kernel-modules']) and opts.hostPathExists.modules
			@volumes.push('/lib/modules:/lib/modules')
		if checkTruthy(@labels['io.resin.features.firmware']) and opts.hostPathExists.firmware
			@volumes.push('/lib/firmware:/lib/firmware')
		if checkTruthy(@labels['io.resin.features.balena-socket'])
			@volumes.push('/var/run/balena.sock:/var/run/balena.sock')
			@environment['DOCKER_HOST'] ?= 'unix:///var/run/balena.sock'
		if checkTruthy(@labels['io.resin.features.supervisor-api'])
			@_addSupervisorApi(opts)
		else
			# We ensure the user hasn't added "supervisor0" to the service's networks
			delete @networks[constants.supervisorNetworkInterface]
		if checkTruthy(@labels['io.resin.features.resin-api'])
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
		@labels['io.resin.app-id'] = @appId.toString()
		@labels['io.resin.service-id'] = @serviceId.toString()
		@labels['io.resin.service-name'] = @serviceName
		return @labels

	extendAndSanitiseExposedPorts: (imageInfo) =>
		@expose = _.map @expose, (p) ->
			p = new String(p)
			if /^[0-9]*$/.test(p)
				p += '/tcp'
			return p
		if imageInfo?.Config?.ExposedPorts?
			for own port, _v of imageInfo.Config.ExposedPorts
				if !_.find(@expose, port)
					@expose.push(port)
		return @expose

	extendAndSanitiseVolumes: (imageInfo) =>
		volumes = []
		for vol in @volumes
			isBind = _.includes(vol, ':')
			if isBind
				[ bindSource, bindDest, mode ] = vol.split(':')
				if !path.isAbsolute(bindSource)
					# Rewrite named volumes to namespace by appId
					volDefinition = "#{@appId}_#{bindSource}:#{bindDest}"
					if mode?
						volDefinition += ":#{mode}"
					volumes.push(volDefinition)
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
			if _.includes(defaults, vol) or !_.includes(vol, ':')
				return null
			bindSource = vol.split(':')[0]
			if !path.isAbsolute(bindSource)
				m = bindSource.match(/[0-9]+_(.+)/)
				return m[1]
			else
				return null
		return _.reject(validVolumes, _.isNil)

	lockPath: =>
		return updateLock.lockPath(@appId)

	killmePath: =>
		return killmePath(@appId, @serviceName)

	killmeFullPathOnHost: =>
		return "#{constants.rootMountPoint}#{@killmePath()}/resin-kill-me"

	defaultBinds: =>
		return defaultBinds(@appId, @serviceName)

	@fromContainer: (container, containerToService) ->
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

		appId = checkInt(container.Config.Labels['io.resin.app-id'])
		serviceId = checkInt(container.Config.Labels['io.resin.service-id'])
		serviceName = container.Config.Labels['io.resin.service-name']
		nameComponents = container.Name.match(/.*_(\d+)_(\d+)$/)
		imageId = checkInt(nameComponents?[1])
		releaseId = checkInt(nameComponents?[2])

		networkMode = container.HostConfig.NetworkMode
		if _.startsWith(networkMode, 'container:')
			networkMode = 'service:' + containerToService[_.replace(networkMode, 'container:', '')]

		hostname = container.Config.Hostname
		# A hostname equal to the first part of the container ID actually
		# means no hostname was specified
		if hostname.length is 12 and container.Id.startsWith(hostname)
			hostname = ''

		service = {
			appId: appId
			serviceId: serviceId
			serviceName: serviceName
			imageId: imageId
			command: container.Config.Cmd
			entrypoint: container.Config.Entrypoint
			networkMode: networkMode
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
			oomKillDisable: container.HostConfig.OomKillDisable
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
			hostname: hostname
			cgroupParent: container.HostConfig.CgroupParent
			groupAdd: container.HostConfig.GroupAdd
			pid: container.HostConfig.PidMode
			pidsLimit: container.HostConfig.PidsLimit
			securityOpt: container.HostConfig.SecurityOpt
			storageOpt: container.HostConfig.StorageOpt
			usernsMode: container.HostConfig.UsernsMode
			ipc: container.HostConfig.IpcMode
			macAddress: container.Config.MacAddress
			user: container.Config.User
			workingDir: container.Config.WorkingDir
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
				m = port.match(PORTS_REGEX)
				if m? # Ignore invalid port mappings
					[ _unused, host = '', external, externalEnd, internal, internalEnd, protocol = 'tcp' ] = m
					external ?= internal
					internalEnd ?= internal
					externalEnd ?= external
					externalRange = _.map([external..externalEnd], String)
					internalRange = _.map([internal..internalEnd], String)
					if externalRange.length == internalRange.length # Ignore invalid port mappings
						for hostPort, ind in externalRange
							containerPort = internalRange[ind]
							exposedPorts["#{containerPort}/#{protocol}"] = {}
							portBindings["#{containerPort}/#{protocol}"] = [ { HostIp: host, HostPort: hostPort } ]
		if @expose?
			for port in @expose
				exposedPorts[port] = {}
		return { exposedPorts, portBindings }

	getBindsAndVolumes: =>
		binds = []
		volumes = {}
		for vol in @volumes
			isBind = _.includes(vol, ':')
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
		networkMode = @networkMode
		if _.startsWith(networkMode, 'service:')
			networkMode = "container:#{_.replace(networkMode, 'service:', '')}_#{@imageId}_#{@releaseId}"
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
			User: @user
			WorkingDir: @workingDir
			HostConfig:
				Memory: @memLimit
				MemoryReservation: @memReservation
				ShmSize: @shmSize
				Privileged: @privileged
				NetworkMode: networkMode
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
				OomKillDisable: @oomKillDisable
				Tmpfs: tmpfs
				Dns: @dns
				DnsSearch: @dnsSearch
				DnsOpt: @dnsOpt
				Ulimits: @ulimitsArray
				ReadonlyRootfs: @readOnly
				Sysctls: @sysctls
				CgroupParent: @cgroupParent
				ExtraHosts: @extraHosts
				GroupAdd: @groupAdd
				PidMode: @pid
				PidsLimit: @pidsLimit
				SecurityOpt: @securityOpt
				UsernsMode: @usernsMode
				IpcMode: @ipc
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
		if !_.isEmpty(@hostname)
			conf.Hostname = @hostname
		if !_.isEmpty(@storageOpt)
			conf.HostConfig.StorageOpt = @storageOpt
		if @macAddress?
			conf.MacAddress = @macAddress
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
			'image'
			'command'
			'entrypoint'
			'networkMode'
			'privileged'
			'restartPolicy'
			'labels'
			'portBindings'
			'exposedPorts'
			'shmSize'
			'cpuShares'
			'cpuQuota'
			'nanoCpus'
			'cpuset'
			'domainname'
			'oomScoreAdj'
			'oomKillDisable'
			'healthcheck'
			'stopSignal'
			'stopGracePeriod'
			'init'
			'readOnly'
			'sysctls'
			'hostname'
			'cgroupParent'
			'pid'
			'pidsLimit'
			'storageOpt'
			'usernsMode'
			'ipc'
			'macAddress'
			'user'
			'workingDir'
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
			'groupAdd'
			'securityOpt'
		]
		return _.isEqual(_.pick(this, propertiesToCompare), _.pick(otherService, propertiesToCompare)) and
			_.isEqual(_.omit(@environment, [ 'RESIN_DEVICE_NAME_AT_INIT' ]), _.omit(otherService.environment, [ 'RESIN_DEVICE_NAME_AT_INIT' ])) and
			@hasSameNetworks(otherService) and
			_.every arraysToCompare, (property) =>
				_.isEmpty(_.xorWith(this[property], otherService[property], _.isEqual))

	isEqualExceptForRunningState: (otherService) =>
		return @isSameContainer(otherService) and
			@releaseId == otherService.releaseId and
			@imageId == otherService.imageId

	isEqual: (otherService) =>
		return @isEqualExceptForRunningState(otherService) and
			@running == otherService.running
