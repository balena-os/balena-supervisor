import { expect } from 'chai';
import { testWithData } from '~/test-lib/mocked-dockerode';

import * as dockerUtils from '~/lib/docker-utils';

describe('Docker Utils', () => {
	describe('Supervisor Address', () => {
		// setup some fake data...
		const networks = {
			supervisor0: {
				IPAM: {
					Config: [
						{
							Gateway: '10.0.105.1',
							Subnet: '10.0.105.0/16',
						},
					],
				},
			},
		};

		// test using existing data...
		it('should return the correct gateway address for supervisor0', async () => {
			await testWithData({ networks }, async () => {
				const gateway = await dockerUtils.getNetworkGateway('supervisor0');
				expect(gateway).to.equal('10.0.105.1');
			});
		});

		it('should return the correct gateway address for host', async () => {
			await testWithData({ networks }, async () => {
				const gateway = await dockerUtils.getNetworkGateway('host');
				expect(gateway).to.equal('127.0.0.1');
			});
		});
	});

	describe('Image Environment', () => {
		const images = {
			['test-image']: {
				Config: {
					Env: ['TEST_VAR_1=1234', 'TEST_VAR_2=5678'],
				},
			},
		};

		// test using existing data...
		it('should return the correct image environment', async () => {
			await testWithData({ images }, async () => {
				const obj = await dockerUtils.getImageEnv('test-image');
				expect(obj).to.have.property('TEST_VAR_1').equal('1234');
				expect(obj).to.have.property('TEST_VAR_2').equal('5678');
			});
		});
	});
});
