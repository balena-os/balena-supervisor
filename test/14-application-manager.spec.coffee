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
{ Service } = require '../src/compose/service'

appDBFormatNormalised = {
	appId: 1234
	commit: 'bar'
	releaseId: 2
	name: 'app'
	source: 'https://api.resin.io'
	services: JSON.stringify([
		{
			appId: 1234
			serviceName: 'serv'
			imageId: 12345
			environment: { FOO: 'var2' }
			labels: {}
			image: 'foo/bar:latest'
			releaseId: 2
			serviceId: 4
			commit: 'bar'
		}
	])
	networks: '{}'
	volumes: '{}'
}

appStateFormat = {
	appId: 1234
	commit: 'bar'
	releaseId: 2
	name: 'app'
	# This technically is not part of the appStateFormat, but in general
	# usage is added before calling normaliseAppForDB
	source: 'https://api.resin.io'
	services: {
		'4': {
			appId: 1234
			serviceName: 'serv'
			imageId: 12345
			environment: { FOO: 'var2' }
			labels: {}
			image: 'foo/bar:latest'
		}
	}
}

appStateFormatNeedsServiceCreate = {
	appId: 1234
	commit: 'bar'
	releaseId: 2
	name: 'app'
	services: [
		{
			appId: 1234
			environment: {
				FOO: 'var2'
			}
			imageId: 12345
			serviceId: 4
			releaseId: 2
			serviceName: 'serv'
			image: 'foo/bar:latest'
		}
	]
	networks: {}
	volumes: {}
}

dependentStateFormat = {
	appId: 1234
	image: 'foo/bar'
	commit: 'bar'
	releaseId: 3
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
	parentApp: 256
	imageId: 45
}

dependentStateFormatNormalised = {
	appId: 1234
	image: 'foo/bar:latest'
	commit: 'bar'
	releaseId: 3
	name: 'app'
	config: { RESIN_FOO: 'var' }
	environment: { FOO: 'var2' }
	parentApp: 256
	imageId: 45
}

currentState = targetState = availableImages = null

dependentDBFormat = {
	appId: 1234
	image: 'foo/bar:latest'
	commit: 'bar'
	releaseId: 3
	name: 'app'
	config: JSON.stringify({ RESIN_FOO: 'var' })
	environment: JSON.stringify({ FOO: 'var2' })
	parentApp: 256
	imageId: 45
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
					Cmd: [ 'someCommand' ]
					Entrypoint: [ 'theEntrypoint' ]
					Env: []
					Labels: {}
					Volumes: []
				}
			})
		stub(@applications.docker, 'getNetworkGateway').returns(Promise.resolve('172.17.0.1'))
		stub(Service, 'extendEnvVars').callsFake (env) ->
			env['ADDITIONAL_ENV_VAR'] = 'foo'
			return env
		@normaliseCurrent = (current) ->
			Promise.map current.local.apps, (app) ->
				Promise.map app.services, (service) ->
					Service.fromComposeObject(service, { appName: 'test' })
				.then (normalisedServices) ->
					appCloned = _.cloneDeep(app)
					appCloned.services = normalisedServices
					return appCloned
			.then (normalisedApps) ->
				currentCloned = _.cloneDeep(current)
				currentCloned.local.apps = normalisedApps
				return currentCloned

		@normaliseTarget = (target, available) =>
			Promise.map target.local.apps, (app) =>
				@applications.normaliseAppForDB(app)
				.then (normalisedApp) =>
					@applications.normaliseAndExtendAppFromDB(normalisedApp)
			.then (apps) ->
				targetCloned = _.cloneDeep(target)
				# We mock what createTargetService does when an image is available
				targetCloned.local.apps = _.map apps, (app) ->
					app.services = _.map app.services, (service) ->
						img = _.find(available, (i) -> i.name == service.config.image)
						if img?
							service.config.image = img.dockerImageId
						return service
					return app
				return targetCloned
		@db.init()
		.then =>
			@config.init()

	beforeEach ->
		{ currentState, targetState, availableImages } = require './lib/application-manager-test-states'

	after ->
		@applications.images.inspectByName.restore()
		@applications.docker.getNetworkGateway.restore()
		Service.extendEnvVars.restore()

	it 'infers a start step when all that changes is a running state', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[0], availableImages[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], [], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{
					action: 'start'
					current: current.local.apps[0].services[1]
					target: target.local.apps[0].services[1]
					serviceId: 24
					appId: 1234
					options: {}
				}])
		)

	it 'infers a kill step when a service has to be removed', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[1], availableImages[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], [], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{
					action: 'kill'
					current: current.local.apps[0].services[1]
					target: null
					serviceId: 24
					appId: 1234
					options: {}
				}])
		)

	it 'infers a fetch step when a service has to be updated', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[2], availableImages[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], [], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{
					action: 'fetch'
					image: @applications.imageForService(target.local.apps[0].services[1])
					serviceId: 24
					appId: 1234
				}])
		)

	it 'does not infer a fetch step when the download is already in progress', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[2], availableImages[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], [ target.local.apps[0].services[1].imageId ], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{ action: 'noop', appId: 1234 }])
		)

	it 'infers a kill step when a service has to be updated but the strategy is kill-then-download', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[3], availableImages[0])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[0], [], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{
					action: 'kill'
					current: current.local.apps[0].services[1]
					target: target.local.apps[0].services[1]
					serviceId: 24
					appId: 1234
					options: {}
				}])
		)

	it 'does not infer to kill a service with default strategy if a dependency is not downloaded', ->
		Promise.join(
			@normaliseCurrent(currentState[4])
			@normaliseTarget(targetState[4], availableImages[2])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[2], [], true, current, target, false, {})
				expect(steps).to.eventually.deep.equal([{
					action: 'fetch'
					image: @applications.imageForService(target.local.apps[0].services[0])
					serviceId: 23
					appId: 1234
				}])
		)

	it 'infers to kill several services as long as there is no unmet dependency', ->
		Promise.join(
			@normaliseCurrent(currentState[0])
			@normaliseTarget(targetState[5], availableImages[1])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], [], true, current, target, false, {})
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill'
						current: current.local.apps[0].services[0]
						target: target.local.apps[0].services[0]
						serviceId: 23
						appId: 1234
						options: {}
					},
					{
						action: 'kill'
						current: current.local.apps[0].services[1]
						target: target.local.apps[0].services[1]
						serviceId: 24
						appId: 1234
						options: {}
					}
				])
		)

	it 'infers to start the dependency first', ->
		Promise.join(
			@normaliseCurrent(currentState[1])
			@normaliseTarget(targetState[4], availableImages[1])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], [], true, current, target, false, {})
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[0]
						serviceId: 23
						appId: 1234
						options: {}
					}
				])
		)

	it 'infers to start a service once its dependency has been met', ->
		Promise.join(
			@normaliseCurrent(currentState[2])
			@normaliseTarget(targetState[4], availableImages[1])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], [], true, current, target, false, {})
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[1]
						serviceId: 24
						appId: 1234
						options: {}
					}
				])
		)

	it 'infers to remove spurious containers', ->
		Promise.join(
			@normaliseCurrent(currentState[3])
			@normaliseTarget(targetState[4], availableImages[1])
			(current, target) =>
				steps = @applications._inferNextSteps(false, availableImages[1], [], true, current, target, false, {})
				expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill'
						current: current.local.apps[0].services[0]
						target: null
						serviceId: 23
						appId: 1234
						options: {}
					},
					{
						action: 'start'
						current: null
						target: target.local.apps[0].services[1]
						serviceId: 24
						appId: 1234
						options: {}
					}
				])
		)

	it 'converts an app from a state format to a db format, adding missing networks and volumes and normalising the image name', ->
		app = @applications.normaliseAppForDB(appStateFormat)
		expect(app).to.eventually.deep.equal(appDBFormatNormalised)

	it 'converts a dependent app from a state format to a db format, normalising the image name', ->
		app = @applications.proxyvisor.normaliseDependentAppForDB(dependentStateFormat)
		expect(app).to.eventually.deep.equal(dependentDBFormat)

	it 'converts an app in DB format into state format, adding default and missing fields', ->
		@applications.normaliseAndExtendAppFromDB(appDBFormatNormalised)
		.then (app) ->
			appStateFormatWithDefaults = _.cloneDeep(appStateFormatNeedsServiceCreate)
			opts = { imageInfo: { Config: { Cmd: [ 'someCommand' ], Entrypoint: [ 'theEntrypoint' ] } } }
			appStateFormatWithDefaults.services = _.map appStateFormatWithDefaults.services, (service) ->
				service.imageName = service.image
				return Service.fromComposeObject(service, opts)
			expect(JSON.parse(JSON.stringify(app))).to.deep.equal(JSON.parse(JSON.stringify(appStateFormatWithDefaults)))

	it 'converts a dependent app in DB format into state format', ->
		app = @applications.proxyvisor.normaliseDependentAppFromDB(dependentDBFormat)
		expect(app).to.eventually.deep.equal(dependentStateFormatNormalised)
