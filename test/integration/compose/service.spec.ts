import _ from 'lodash';

import { expect } from 'chai';

import Service from '~/src/compose/service';
import * as deviceApi from '~/src/device-api';

describe('compose/service: integration tests', () => {
	describe('Feature labels', () => {
		// TODO: this is the only part of the service module that needs to be integration tested. This is becase it
		// needs to access the database to get the service scoped api keys. If the keys were generated/queried in
		// App.fromTargetState and passed to the service as a parameter, it would push this module to the domain model
		// which is where it belongs
		describe('io.balena.supervisor-api', () => {
			it('sets BALENA_SUPERVISOR_HOST, BALENA_SUPERVISOR_PORT and BALENA_SUPERVISOR_ADDRESS env vars', async () => {
				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.supervisor-api': '1',
						},
					},
					{
						appName: 'test',
						supervisorApiHost: 'supervisor',
						listenPort: 48484,
					} as any,
				);

				expect(
					service.config.environment['BALENA_SUPERVISOR_HOST'],
				).to.be.equal('supervisor');

				expect(
					service.config.environment['BALENA_SUPERVISOR_PORT'],
				).to.be.equal('48484');

				expect(
					service.config.environment['BALENA_SUPERVISOR_ADDRESS'],
				).to.be.equal('http://supervisor:48484');
			});

			it('sets BALENA_API_KEY env var to the scoped API key value', async () => {
				const mykey = await deviceApi.generateScopedKey(123456, 'foobar');

				const service = await Service.fromComposeObject(
					{
						appId: 123456,
						serviceId: 123456,
						serviceName: 'foobar',
						labels: {
							'io.balena.features.supervisor-api': '1',
						},
					},
					{
						appName: 'test',
						supervisorApiHost: 'supervisor',
						listenPort: 48484,
					} as any,
				);

				expect(
					service.config.environment['BALENA_SUPERVISOR_API_KEY'],
				).to.be.equal(mykey);
			});
		});
	});
});
