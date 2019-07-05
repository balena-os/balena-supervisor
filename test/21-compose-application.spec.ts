import { expect } from 'chai';

import Application from '../src/compose/application';
import { AppDBFormat } from '../src/compose/application-manager';
import Network from '../src/compose/network';
import Volume from '../src/compose/volume';

describe('Compose Applications', () => {
	describe('Database format', () => {
		// Explicitly cast to any so we can pass it to the
		// application without further casts
		const notFoundImage: any = {
			inspectByName: async () => {
				const e = new Error() as any;
				e.statusCode = 404;
				throw e;
			},
		};
		const constructOpts: any = {
			logger: {},
			docker: {},
		};

		const metadata: any = {
			appName: 'appName',
			listenPort: 1234,
		};

		it('should correctly construct an application from a database entry', async () => {
			const dbFormat: AppDBFormat = {
				appId: 1,
				commit: 'asd',
				name: 'appName',
				source: 'appSource',
				releaseId: 10,
				networks: JSON.stringify({
					test_network: {
						labels: {
							TEST_LABEL: 'value',
						},
						enable_ipv6: true,
					},
					second_test_network: {},
				}),
				volumes: JSON.stringify({
					test_volume: {
						labels: {
							TEST_LABEL: 'value2',
						},
					},
					second_test_volume: {},
				}),
				services: JSON.stringify([
					{
						environment: {},
						labels: { 'io.balena.features.supervisor-api': '1' },
						imageId: 1,
						serviceName: 'main',
						serviceId: 1,
						image: 'serviceImage:latest',
						running: true,
						appId: 1,
						releaseId: 10,
						commit: 'localrelease',
					},
				]),
			};

			const app = await Application.newFromTarget(
				dbFormat,
				notFoundImage,
				constructOpts,
				metadata,
			);

			expect(app.appId).to.equal(1);
			expect(app.name).to.equal('appName');
			expect(app.releaseId).to.equal(10);
			expect(app.commit).to.equal('asd');

			// volumes
			expect(app.volumes).to.have.property('test_volume');
			const v = app.volumes['test_volume'];
			expect(v).instanceOf(Volume);
			expect(v)
				.to.have.property('appId')
				.that.equals(1);
			expect(v.config)
				.to.have.property('labels')
				.that.deep.equals({
					TEST_LABEL: 'value2',
					'io.balena.supervised': 'true',
				});
			expect(app.volumes).to.have.property('second_test_volume');

			// networks
			expect(app.networks).to.have.property('test_network');
			const n = app.networks['test_network'];
			expect(n).instanceOf(Network);
			expect(n)
				.to.have.property('appId')
				.that.equals(1);
			expect(n.config)
				.to.have.property('enableIPv6')
				.that.equals(true);
			expect(n.config)
				.to.have.property('labels')
				.that.deep.equals({
					TEST_LABEL: 'value',
				});
			expect(app.networks).to.have.property('second_test_network');

			expect(app.services).to.have.property('1');
			const service = app.services[1];
			expect(service)
				.to.have.property('appId')
				.that.equals(1);
			expect(service)
				.to.have.property('releaseId')
				.to.equal(10);
			expect(service)
				.to.have.property('imageId')
				.that.equals(1);
			const config = service.config;
			expect(config)
				.to.have.property('image')
				.that.equals('serviceImage:latest');
			expect(config)
				.to.have.property('labels')
				.that.deep.equals({
					'io.balena.app-id': '1',
					'io.balena.features.supervisor-api': '1',
					'io.balena.service-id': '1',
					'io.balena.service-name': 'main',
					'io.balena.supervised': 'true',
				});
		});
	});
});
