import { expect } from 'chai';
import { isRight } from 'fp-ts/lib/Either';
import * as nock from 'nock';

import { TargetState } from '~/src/types';
import * as config from '~/src/config';
import * as legacy from '~/lib/legacy';

describe('lib/legacy', () => {
	before(async () => {
		// Set the device uuid and name
		// these migration methods read some data from the database
		// (and other data from the API)
		// which is also why they need to be defined as integration tests
		// TODO: when the supervisor is a full app, we'll be able to control updates
		// using contracts, meaning this legacy code can dissapear
		await config.set({ uuid: 'local' });
		await config.set({ name: 'my-device' });
	});

	describe('Converting target state v2 to v3', () => {
		it('accepts a local target state with empty configuration', async () => {
			const target = await legacy.fromV2TargetState({} as any, true);

			const decoded = TargetState.decode(target);
			if (!isRight(decoded)) {
				// We do it this way let the type guard be triggered
				expect.fail('Resulting target state is a valid v3 target state');
			}

			const decodedTarget = decoded.right;
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('name')
				.that.equals('my-device');
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('apps')
				.that.deep.equals({});
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('config')
				.that.deep.equals({});
		});

		it('accepts a local target state for an app without releases', async () => {
			const target = await legacy.fromV2TargetState(
				{
					local: {
						name: 'my-new-name',
						config: {
							BALENA_SUPERVISOR_PORT: '11111',
						},
						apps: {
							'1': {
								name: 'hello-world',
							},
						},
					},
				} as any,
				true,
			);

			const decoded = TargetState.decode(target);
			if (!isRight(decoded)) {
				console.log(decoded.left);
				// We do it this way let the type guard be triggered
				expect.fail('Resulting target state is a valid v3 target state');
			}

			const decodedTarget = decoded.right;

			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('config')
				.that.has.property('BALENA_SUPERVISOR_PORT')
				.that.equals('11111');
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('name')
				.that.equals('my-new-name');
			expect(decodedTarget).to.have.property('local').that.has.property('apps');

			const apps = decodedTarget.local.apps;

			expect(apps)
				.to.have.property('1')
				.that.has.property('name')
				.that.equals('hello-world');
			expect(apps)
				.to.have.property('1')
				.that.has.property('releases')
				.that.deep.equals({});
		});

		it('accepts a local target state with valid config and apps', async () => {
			const target = await legacy.fromV2TargetState(
				{
					local: {
						name: 'my-new-name',
						config: {
							BALENA_SUPERVISOR_PORT: '11111',
						},
						apps: {
							'1': {
								releaseId: 1,
								commit: 'localrelease',
								name: 'hello-world',
								services: {
									'1': {
										imageId: 1,
										serviceName: 'hello',
										image: 'ubuntu:latest',
										running: true,
										environment: {},
										labels: { 'io.balena.features.api': 'true' },
										privileged: true,
										ports: ['3001:3001'],
									},
								},
								networks: {
									my_net: {
										labels: {
											'io.balena.some.label': 'foo',
										},
									},
								},
								volumes: {
									my_volume: {
										labels: {
											'io.balena.some.label': 'foo',
										},
									},
								},
							},
						},
					},
				},
				true,
			);

			const decoded = TargetState.decode(target);
			if (!isRight(decoded)) {
				// We do it this way let the type guard be triggered
				expect.fail('Resulting target state is a valid v3 target state');
			}

			const decodedTarget = decoded.right;

			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('config')
				.that.has.property('BALENA_SUPERVISOR_PORT')
				.that.equals('11111');
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('name')
				.that.equals('my-new-name');
			expect(decodedTarget).to.have.property('local').that.has.property('apps');

			const apps = decodedTarget.local.apps;
			expect(apps)
				.to.have.property('1')
				.that.has.property('releases')
				.that.has.property('localrelease');
			expect(apps)
				.to.have.property('1')
				.that.has.property('name')
				.that.equals('hello-world');

			const release = apps['1'].releases.localrelease;
			expect(release).to.have.property('id').that.equals(1);
			expect(release).to.have.property('services').that.has.property('hello');

			const service = release.services.hello;
			expect(service).to.have.property('image').that.equals('ubuntu:latest');
			expect(service)
				.to.have.property('composition')
				.that.deep.equals({ privileged: true, ports: ['3001:3001'] });

			expect(release)
				.to.have.property('networks')
				.that.has.property('my_net')
				.that.has.property('labels')
				.that.deep.equals({ 'io.balena.some.label': 'foo' });
			expect(release)
				.to.have.property('volumes')
				.that.has.property('my_volume')
				.that.has.property('labels')
				.that.deep.equals({ 'io.balena.some.label': 'foo' });
		});

		it('accepts a cloud target state and requests app uuid from API', async () => {
			const apiEndpoint = await config.get('apiEndpoint');

			nock(apiEndpoint)
				.get('/v6/application(1)?$select=uuid')
				.reply(200, { d: [{ uuid: 'some-uuid' }] });

			const target = await legacy.fromV2TargetState(
				{
					local: {
						name: 'my-new-name',
						config: {
							BALENA_SUPERVISOR_PORT: '11111',
						},
						apps: {
							'1': {
								name: 'hello-world',
							},
						},
					},
				} as any,
				false, // local = false
			);

			const decoded = TargetState.decode(target);
			if (!isRight(decoded)) {
				// We do it this way let the type guard be triggered
				expect.fail('Resulting target state is a valid v3 target state');
			}

			const decodedTarget = decoded.right;

			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('config')
				.that.has.property('BALENA_SUPERVISOR_PORT')
				.that.equals('11111');
			expect(decodedTarget)
				.to.have.property('local')
				.that.has.property('name')
				.that.equals('my-new-name');
			expect(decodedTarget).to.have.property('local').that.has.property('apps');

			const apps = decodedTarget.local.apps;

			expect(apps)
				.to.have.property('some-uuid')
				.that.has.property('name')
				.that.equals('hello-world');
			expect(apps)
				.to.have.property('some-uuid')
				.that.has.property('id')
				.that.equals(1);
			expect(apps)
				.to.have.property('some-uuid')
				.that.has.property('releases')
				.that.deep.equals({});
		});
	});
});
