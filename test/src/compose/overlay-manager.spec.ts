import Overlay from '../../../src/compose/overlay';
import * as overlayManager from '../../../src/compose/overlay-manager';

import { expect } from 'chai';

describe('compose/overlay-manager', () => {
	describe('converting a list of overlays into a target state for the host', () => {
		it('returns an empty target state if the overlay list is empty', () => {
			expect(overlayManager.toTargetState([])).to.equal(
				JSON.stringify({ apps: {} }),
			);
		});

		it('creates apps configuration from a list of overlays', () => {
			const list = [
				Overlay.fromService(
					{
						appId: 123,
						imageId: 1,
						serviceId: 1,
						serviceName: 'one',
						releaseId: 1,
						releaseVersion: '0.0.1',
						imageName: 'one',
						uuid: 'deadbeef',
					} as any,
					'app-one',
				),
				Overlay.fromService({
					appId: 456,
					imageId: 2,
					serviceId: 2,
					serviceName: 'two',
					releaseId: 2,
					releaseVersion: '0.0.1',
					imageName: 'two',
					uuid: 'deadca1f',
				} as any),
			];

			expect(JSON.parse(overlayManager.toTargetState(list))).to.deep.equal({
				apps: {
					deadbeef: {
						appId: 123,
						name: 'app-one',
						releaseId: 1,
						releaseVersion: '0.0.1',
						uuid: 'deadbeef',
						services: {
							'1': {
								serviceName: 'one',
								image: 'one',
								labels: {
									'io.balena.image.class': 'overlay',
									'io.balena.image.requires-reboot': '1',
									'io.balena.image.store': 'data',
								},
							},
						},
						volumes: {},
						networks: {},
					},
					deadca1f: {
						appId: 456,
						releaseId: 2,
						releaseVersion: '0.0.1',
						uuid: 'deadca1f',
						services: {
							'1': {
								serviceName: 'two',
								image: 'two',
								labels: {
									'io.balena.image.class': 'overlay',
									'io.balena.image.requires-reboot': '1',
									'io.balena.image.store': 'data',
								},
							},
						},
						volumes: {},
						networks: {},
					},
				},
			});
		});
	});
});
