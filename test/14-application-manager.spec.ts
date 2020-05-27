import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { stub } from 'sinon';

import Config from '../src/config';
import DB from '../src/db';

import Network from '../src/compose/network';

import Service from '../src/compose/service';
import Volume from '../src/compose/volume';
import DeviceState from '../src/device-state';
import EventTracker from '../src/event-tracker';

import chai = require('./lib/chai-config');
import prepare = require('./lib/prepare');
import { initApiSecrets } from '../src/lib/api-secrets';

// tslint:disable-next-line
chai.use(require('chai-events'));
const { expect } = chai;

let availableImages: any[] | null;
let targetState: any[] | null;

const appDBFormatNormalised = {
	appId: 1234,
	commit: 'bar',
	releaseId: 2,
	name: 'app',
	source: 'https://api.resin.io',
	services: JSON.stringify([
		{
			appId: 1234,
			serviceName: 'serv',
			imageId: 12345,
			environment: { FOO: 'var2' },
			labels: {},
			image: 'foo/bar:latest',
			releaseId: 2,
			serviceId: 4,
			commit: 'bar',
		},
	]),
	networks: '{}',
	volumes: '{}',
};

const appStateFormat = {
	appId: 1234,
	commit: 'bar',
	releaseId: 2,
	name: 'app',
	// This technically is not part of the appStateFormat, but in general
	// usage is added before calling normaliseAppForDB
	source: 'https://api.resin.io',
	services: {
		'4': {
			appId: 1234,
			serviceName: 'serv',
			imageId: 12345,
			environment: { FOO: 'var2' },
			labels: {},
			image: 'foo/bar:latest',
		},
	},
};

const appStateFormatNeedsServiceCreate = {
	appId: 1234,
	commit: 'bar',
	releaseId: 2,
	name: 'app',
	services: [
		{
			appId: 1234,
			environment: {
				FOO: 'var2',
			},
			imageId: 12345,
			serviceId: 4,
			releaseId: 2,
			serviceName: 'serv',
			image: 'foo/bar:latest',
		},
	],
	networks: {},
	volumes: {},
};

const dependentStateFormat = {
	appId: 1234,
	image: 'foo/bar',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: { RESIN_FOO: 'var' },
	environment: { FOO: 'var2' },
	parentApp: 256,
	imageId: 45,
};

const dependentStateFormatNormalised = {
	appId: 1234,
	image: 'foo/bar:latest',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: { RESIN_FOO: 'var' },
	environment: { FOO: 'var2' },
	parentApp: 256,
	imageId: 45,
};

let currentState = (targetState = availableImages = null);

const dependentDBFormat = {
	appId: 1234,
	image: 'foo/bar:latest',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: JSON.stringify({ RESIN_FOO: 'var' }),
	environment: JSON.stringify({ FOO: 'var2' }),
	parentApp: 256,
	imageId: 45,
};

describe('ApplicationManager', function () {
	before(function () {
		prepare();
		this.db = new DB();
		initApiSecrets(this.db);
		this.config = new Config({ db: this.db });
		const eventTracker = new EventTracker();
		this.logger = {
			clearOutOfDateDBLogs: () => {
				/* noop */
			},
		} as any;
		this.deviceState = new DeviceState({
			db: this.db,
			config: this.config,
			eventTracker,
			logger: this.logger,
			apiBinder: null as any,
		});
		this.applications = this.deviceState.applications;
		stub(this.applications.images, 'inspectByName').callsFake((_imageName) =>
			Bluebird.Promise.resolve({
				Config: {
					Cmd: ['someCommand'],
					Entrypoint: ['theEntrypoint'],
					Env: [],
					Labels: {},
					Volumes: [],
				},
			}),
		);
		stub(this.applications.docker, 'getNetworkGateway').returns(
			Bluebird.Promise.resolve('172.17.0.1'),
		);
		stub(this.applications.docker, 'listContainers').returns(
			Bluebird.Promise.resolve([]),
		);
		stub(this.applications.docker, 'listImages').returns(
			Bluebird.Promise.resolve([]),
		);
		stub(Service as any, 'extendEnvVars').callsFake(function (env) {
			env['ADDITIONAL_ENV_VAR'] = 'foo';
			return env;
		});
		this.normaliseCurrent = function (current: {
			local: { apps: Iterable<unknown> | PromiseLike<Iterable<unknown>> };
		}) {
			return Bluebird.Promise.map(current.local.apps, async (app: any) => {
				return Bluebird.Promise.map(app.services, (service) =>
					Service.fromComposeObject(
						service as any,
						{ appName: 'test' } as any,
						'super-secret-key',
					),
				).then((normalisedServices) => {
					const appCloned = _.cloneDeep(app);
					appCloned.services = normalisedServices;
					appCloned.networks = _.mapValues(
						appCloned.networks,
						(config, name) => {
							return Network.fromComposeObject(name, app.appId, config, {
								docker: this.applications.docker,
								logger: this.logger,
							});
						},
					);
					return appCloned;
				});
			}).then(function (normalisedApps) {
				const currentCloned = _.cloneDeep(current);
				// @ts-ignore
				currentCloned.local.apps = _.keyBy(normalisedApps, 'appId');
				return currentCloned;
			});
		};

		this.normaliseTarget = (
			target: {
				local: { apps: Iterable<unknown> | PromiseLike<Iterable<unknown>> };
			},
			available: any,
		) => {
			return Bluebird.Promise.map(target.local.apps, (app) => {
				return this.applications
					.normaliseAppForDB(app)
					.then((normalisedApp: any) => {
						return this.applications.normaliseAndExtendAppFromDB(normalisedApp);
					});
			}).then(function (apps) {
				const targetCloned = _.cloneDeep(target);
				// We mock what createTargetService does when an image is available
				targetCloned.local.apps = _.map(apps, function (app) {
					app.services = _.map(app.services, function (service) {
						const img = _.find(
							available,
							(i) => i.name === service.config.image,
						);
						if (img != null) {
							service.config.image = img.dockerImageId;
						}
						return service;
					});
					return app;
				});
				// @ts-ignore
				targetCloned.local.apps = _.keyBy(targetCloned.local.apps, 'appId');
				return targetCloned;
			});
		};
		return this.db.init().then(() => {
			return this.config.init();
		});
	});

	beforeEach(
		() =>
			({
				currentState,
				targetState,
				availableImages,
			} = require('./lib/application-manager-test-states')),
	);

	after(function () {
		this.applications.images.inspectByName.restore();
		this.applications.docker.getNetworkGateway.restore();
		this.applications.docker.listContainers.restore();
		return (Service as any).extendEnvVars.restore();
	});

	it('should init', function () {
		return this.applications.init();
	});

	it('infers a start step when all that changes is a running state', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[0], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'start',
						current: current.local.apps['1234'].services[1],
						target: target.local.apps['1234'].services[1],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers a kill step when a service has to be removed', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[1], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[1],
						target: undefined,
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers a fetch step when a service has to be updated', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[2], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'fetch',
						image: this.applications.imageForService(
							target.local.apps['1234'].services[1],
						),
						serviceId: 24,
						appId: 1234,
						serviceName: 'anotherService',
					},
				]);
			},
		);
	});

	it('does not infer a fetch step when the download is already in progress', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[2], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[target.local.apps['1234'].services[1].imageId],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{ action: 'noop', appId: 1234 },
				]);
			},
		);
	});

	it('infers a kill step when a service has to be updated but the strategy is kill-then-download', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[3], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[1],
						target: target.local.apps['1234'].services[1],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('does not infer to kill a service with default strategy if a dependency is not downloaded', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[4]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[2]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[2],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'fetch',
						image: this.applications.imageForService(
							target.local.apps['1234'].services[0],
						),
						serviceId: 23,
						appId: 1234,
						serviceName: 'aservice',
					},
					{ action: 'noop', appId: 1234 },
				]);
			},
		);
	});

	it('infers to kill several services as long as there is no unmet dependency', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[5], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[0],
						target: target.local.apps['1234'].services[0],
						serviceId: 23,
						appId: 1234,
						options: {},
					},
					{
						action: 'kill',
						current: current.local.apps['1234'].services[1],
						target: target.local.apps['1234'].services[1],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to start the dependency first', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[1]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[0],
						serviceId: 23,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to start a service once its dependency has been met', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[2]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[1],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to remove spurious containers', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[3]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[0],
						target: undefined,
						serviceId: 23,
						appId: 1234,
						options: {},
					},
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[1],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('converts an app from a state format to a db format, adding missing networks and volumes and normalising the image name', function () {
		const app = this.applications.normaliseAppForDB(appStateFormat);
		return expect(app).to.eventually.deep.equal(appDBFormatNormalised);
	});

	it('converts a dependent app from a state format to a db format, normalising the image name', function () {
		const app = this.applications.proxyvisor.normaliseDependentAppForDB(
			dependentStateFormat,
		);
		return expect(app).to.eventually.deep.equal(dependentDBFormat);
	});

	it('converts an app in DB format into state format, adding default and missing fields', function () {
		return this.applications
			.normaliseAndExtendAppFromDB(appDBFormatNormalised)
			.then(function (app: any) {
				const appStateFormatWithDefaults = _.cloneDeep(
					appStateFormatNeedsServiceCreate,
				);
				const opts = {
					imageInfo: {
						Config: { Cmd: ['someCommand'], Entrypoint: ['theEntrypoint'] },
					},
				};
				(appStateFormatWithDefaults.services as any) = _.map(
					appStateFormatWithDefaults.services,
					function (service) {
						// @ts-ignore
						service.imageName = service.image;
						return Service.fromComposeObject(
							service,
							opts as any,
							'super-secret-key',
						);
					},
				);
				return expect(JSON.parse(JSON.stringify(app))).to.deep.equal(
					JSON.parse(JSON.stringify(appStateFormatWithDefaults)),
				);
			});
	});

	it('converts a dependent app in DB format into state format', function () {
		const app = this.applications.proxyvisor.normaliseDependentAppFromDB(
			dependentDBFormat,
		);
		return expect(app).to.eventually.deep.equal(dependentStateFormatNormalised);
	});

	return describe('Volumes', function () {
		before(function () {
			return stub(this.applications, 'removeAllVolumesForApp').returns(
				Bluebird.Promise.resolve([
					{
						action: 'removeVolume',
						current: Volume.fromComposeObject('my_volume', 12, {}, {
							docker: null,
							logger: null,
						} as any),
					},
				]),
			);
		});

		after(function () {
			return this.applications.removeAllVolumesForApp.restore();
		});

		it('should not remove volumes when they are no longer referenced', function () {
			return Bluebird.Promise.join(
				// @ts-ignore
				this.normaliseCurrent(currentState[6]),
				// @ts-ignore
				this.normaliseTarget(targetState[0], availableImages[0]),
				(current, target) => {
					return this.applications
						._inferNextSteps(
							false,
							// @ts-ignore
							availableImages[0],
							[],
							true,
							current,
							target,
							false,
							{},
							{},
						)
						.then(
							// @ts-ignore
							(steps) =>
								expect(
									_.every(steps, (s) => s.action !== 'removeVolume'),
									'Volumes from current app should not be removed',
								).to.be.true,
						);
				},
			);
		});

		return it('should remove volumes from previous applications', function () {
			return Bluebird.Promise.join(
				// @ts-ignore
				this.normaliseCurrent(currentState[5]),
				// @ts-ignore
				this.normaliseTarget(targetState[6], []),
				(current, target) => {
					return (
						this.applications
							._inferNextSteps(
								false,
								[],
								[],
								true,
								current,
								target,
								false,
								{},
								{},
							)
							// tslint:disable-next-line
							.then(function (steps: { current: any }[]) {
								expect(steps).to.have.length(1);
								expect(steps[0])
									.to.have.property('action')
									.that.equals('removeVolume');
								return expect(steps[0].current)
									.to.have.property('appId')
									.that.equals(12);
							})
					);
				},
			);
		});
	});
});
