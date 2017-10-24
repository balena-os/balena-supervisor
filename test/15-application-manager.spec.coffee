Promise = require 'bluebird'
_ = require 'lodash'
m = require 'mochainon'

{ stub } = m.sinon
m.chai.use(require('chai-events'))
{ expect } = m.chai

prepare = require './lib/prepare'
DeviceState = require '../src/device-state'
DB = require('../src/db')
Config = require('../src/config')
Service = require '../src/compose/service'

{ currentState, targetState, availableImages } = require './lib/application-manager-test-states'

appDBFormat = {
	appId: '1234' 
	commit: 'bar'
	releaseId: '2'
	name: 'app'
	services: JSON.stringify([
		{
			appId: '1234'
			serviceId: '4'
			serviceName: 'serv'
			environment: { FOO: 'var2' }
			labels: {}
			image: 'foo/bar'
		}
	])
}

appDBFormatNormalised = {
	appId: '1234' 
	commit: 'bar'
	releaseId: '2'
	name: 'app'
	services: JSON.stringify([
		{
			appId: '1234'
			serviceName: 'serv'
			imageId: 'abcd'
			environment: { FOO: 'var2' }
			labels: {}
			image: 'foo/bar:latest'
			releaseId: '2'
			serviceId: '4'
			commit: 'bar'
		}
	])
	networks: "{}"
	volumes: "{}"
}

appStateFormat = {
	appId: '1234' 
	commit: 'bar'
	releaseId: '2'
	name: 'app'
	services: {
		'4': {
			appId: '1234'
			serviceName: 'serv'
			imageId: 'abcd'
			environment: { FOO: 'var2' }
			labels: {}
			image: 'foo/bar:latest'
		}
	}
}

appStateFormatWithDefaults = {
	appId: '1234' 
	commit: 'bar'
	releaseId: '2'
	name: 'app'
	services: [
		{
			appId: '1234'
			commit: 'bar'
			environment: {
				FOO: 'var2'
				ADDITIONAL_ENV_VAR: 'foo'
			}
			labels: {
				'io.resin.app_id': '1234'
				'io.resin.commit': 'bar'
				'io.resin.service_id': '4'
				'io.resin.image_id': 'abcd'
				'io.resin.supervised': 'true'
				'io.resin.service_name': 'serv'
			}
			imageId: 'abcd'
			serviceId: '4'
			releaseId: '2'
			serviceName: 'serv'
			image: 'foo/bar:latest'
			privileged: false
			restartPolicy: {
				Name: 'unless-stopped'
				MaximumRetryCount: 0
			}
			volumes: [
				'/tmp/resin-supervisor/services/1234/serv:/tmp/resin'
			]
			running: true
			expose: []
			ports: []
			cap_add: []
			cap_drop: []
			network_mode: '1234'
			devices: []
		}
	]
	networks: {}
	volumes: {}
}

dependentStateFormat = {
	appId: '1234'
	image: 'foo/bar'
	commit: 'bar'
	releaseId: '3'
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
	parentApp: '256'
}

dependentStateFormatNormalised = {
	appId: '1234'
	image: 'foo/bar:latest'
	commit: 'bar'
	releaseId: '3'
	name: 'app'
	parentApp: '256'
}

dependentDBFormat = {
	appId: '1234' 
	image: 'foo/bar:latest'
	commit: 'bar'
	releaseId: '3'
	name: 'app'
	parentApp: '256'
}

describe 'ApplicationManager', ->
	before ->
		@timeout(5000)
		prepare()
		@db = new DB()
		@config = new Config({ @db })
		eventTracker = {
			track: console.log
		}
		@deviceState = new DeviceState({ @db, @config, eventTracker })
		@applications = @deviceState.applications
		stub(@applications.images, 'inspectByName').callsFake (imageName) ->
			Promise.resolve({
				Config: {
					Env: []
					Labels: {}
					Volumes: []
				}
			})
		stub(@applications.docker, 'defaultBridgeGateway').returns(Promise.resolve('172.17.0.1'))
		stub(@applications.docker, 'getNetworkGateway').returns(Promise.resolve('172.17.0.1'))
		stub(Service.prototype, 'extendEnvVars').callsFake (env) ->
			@environment['ADDITIONAL_ENV_VAR'] = 'foo'
			return @environment
		@normaliseCurrent = (current) =>
			Promise.map current.local.apps, (app) =>
				Promise.map app.services, (service) ->
					new Service(service)
				.then (normalisedServices) ->
					appCloned = _.clone(app)
					appCloned.services = normalisedServices
					return appCloned
			.then (normalisedApps) ->
				currentCloned = _.clone(current)
				currentCloned.local.apps = normalisedApps
				return currentCloned

		@normaliseTarget = (target) =>
			Promise.map target.local.apps, (app) =>
				@applications.normaliseAppForDB(app)
				.then (normalisedApp) =>
					@applications.normaliseAndExtendAppFromDB(normalisedApp)
			.then (apps) ->
				targetCloned = _.cloneDeep(target)
				targetCloned.local.apps = apps
				return targetCloned
		@db.init()
		.then =>
			@config.init()

	after ->
		@applications.images.inspectByName.restore()
		@applications.docker.defaultBridgeGateway.restore()
		@applications.docker.getNetworkGateway.restore()
		Service.prototype.extendEnvVars.restore()

	it 'infers a start step when all that changes is a running state', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], current, target, [])
				expect(steps).to.eventually.deep.equal([{
					action: 'start'
					current: current.local.apps[0].services[1]
					target: target.local.apps[0].services[1]
					serviceId: '24'
				}])
		)

	it 'infers a kill step when a service has to be removed', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[1])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], current, target, [])
				expect(steps).to.eventually.deep.equal([{
					action: 'kill'
					current: current.local.apps[0].services[1]
					target: null
					serviceId: '24'
				}])
		)

	it 'infers a fetch step when a service has to be updated', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[2])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], current, target, [])
				expect(steps).to.eventually.deep.equal([{
					action: 'fetch'
					image: @applications.imageForService(target.local.apps[0].services[1])
					serviceId: '24'
				}])
		)

	it 'does not infer a step when it is already in progress', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[2])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], current, target, [{
					action: 'fetch'
					image: @applications.imageForService(target.local.apps[0].services[1])
					serviceId: '24'
				}])
				expect(steps).to.eventually.deep.equal([])
		)

	it 'infers a kill step when a service has to be updated but the strategy is kill-then-download', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[3])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], current, target, [])
				expect(steps).to.eventually.deep.equal([{
					action: 'kill'
					current: current.local.apps[0].services[1]
					target: target.local.apps[0].services[1]
					serviceId: '24'
				}])
		)

	it 'does not infer to kill a service with default strategy if a dependency is unmet', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[4])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], current, target, [])
				expect(steps).to.eventually.deep.equal([{
					action: 'kill'
					current: current.local.apps[0].services[0]
					target: target.local.apps[0].services[0]
					serviceId: '23'
				}])
		)

	it 'infers to kill several services as long as there is no unmet dependency', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[5])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], current, target, [])
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill'
						current: current.local.apps[0].services[0]
						target: target.local.apps[0].services[0]
						serviceId: '23'
					},
					{
						action: 'kill'
						current: current.local.apps[0].services[1]
						target: target.local.apps[0].services[1]
						serviceId: '24'
					}
				])
		)

	it 'infers to start the dependency first', ->
		Promise.join(
			@normaliseCurrent(currentState[1])
			@normaliseTarget(targetState[4])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], current, target, [])
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[0]
						serviceId: '23'
					}
				])
		)

	it 'infers to start a service once its dependency has been met', ->
		Promise.join(
			@normaliseCurrent(currentState[2])
			@normaliseTarget(targetState[4])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], current, target, [])
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[1]
						serviceId: '24'
					}
				])
		)

	it 'infers to remove spurious containers', ->
		Promise.join(
			@normaliseCurrent(currentState[3])
			@normaliseTarget(targetState[4])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], current, target, [])
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill'
						current: current.local.apps[0].services[0]
						target: null
						serviceId: '23'
					},
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[1]
						serviceId: '24'
					}
				])
		)

	it 'converts an app from a state format to a db format, adding missing networks and volumes and normalising the image name', ->
		app = @applications.normaliseAppForDB(appStateFormat)
		expect(app).to.eventually.deep.equal(appDBFormatNormalised)

	it 'converts a dependent app from a state format to a db format, normalising the image name', ->
		app = @applications.proxyvisor._normaliseDependentAppForDB(dependentStateFormat)
		expect(app).to.eventually.deep.equal(dependentDBFormat)

	it 'converts an app in DB format into state format, adding default and missing fields', ->
		@applications.normaliseAndExtendAppFromDB(appDBFormatNormalised)
		.then (app) ->
			expect(JSON.parse(JSON.stringify(app))).to.deep.equal(appStateFormatWithDefaults)

	it 'converts a dependent app in DB format into state format', ->
		app = @applications.proxyvisor._normaliseDependentAppFromDB(dependentDBFormat)
		expect(app).to.eventually.deep.equal(dependentStateFormatNormalised)
