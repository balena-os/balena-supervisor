import noop = require('lodash/noop');

import { assert, expect } from 'chai';
import * as sinon from 'sinon';

import ApplicationManager from '../src/compose/application-manager';
import Database from '../src/db';
import Config from '../src/config';

const cloudTargetStates = {
	simple: {
		'1032480': {
			name: 'testapp',
			commit: '3f80bb77c68680c685fb67006d3d2e90',
			releaseId: 990450,
			services: {
				'29396': {
					privileged: true,
					tty: true,
					restart: 'always',
					network_mode: 'host',
					volumes: ['resin-data:/data'],
					labels: {
						'io.resin.features.dbus': '1',
						'io.resin.features.firmware': '1',
						'io.resin.features.kernel-modules': '1',
						'io.resin.features.resin-api': '1',
						'io.resin.features.supervisor-api': '1',
					},
					imageId: 1316370,
					serviceName: 'main',
					image:
						'registry2.balena-cloud.com/v2/1daa88e3330c8a033cc7797d46b6cb59@sha256:d82e5d069979c6f57e5c2248ca5e853d9276689e3f8a75eef3346318e43680a4',
					running: true,
					environment: {},
				},
			},
			volumes: {
				'resin-data': {},
			},
			networks: {},
		},
	},
};

describe.only('Compose Application Manager', () => {
	const db = new Database();
	const config = new Config({ db });
	const eventTracker = {
		track: console.log,
	};
	const logger: any = {
		clearOutOfDataDBLogs: noop,
	};

	it('should correctly generate target states in db format', async () => {
		const am = new ApplicationManager({
			config,
			db,
			logger,
		});
		expect(
			// We cast to any here as normalizeAppForDb is private
			await (am as any).normalizeAppForDB({
				appId: 1032480,
				source: 'api.balena-cloud.com',
				...cloudTargetStates.simple['1032480'],
			}),
		).to.deep.equal({
			appId: 1032480,
			commit: '3f80bb77c68680c685fb67006d3d2e90',
			name: 'testapp',
			source: 'api.balena-cloud.com',
			releaseId: 990450,
			networks: JSON.stringify({}),
			volumes: JSON.stringify({
				'resin-data': {},
			}),
			services: JSON.stringify([
				{
					privileged: true,
					tty: true,
					restart: 'always',
					network_mode: 'host',
					volumes: ['resin-data:/data'],
					labels: {
						'io.resin.features.dbus': '1',
						'io.resin.features.firmware': '1',
						'io.resin.features.kernel-modules': '1',
						'io.resin.features.resin-api': '1',
						'io.resin.features.supervisor-api': '1',
					},
					imageId: 1316370,
					serviceName: 'main',
					image:
						'registry2.balena-cloud.com/v2/1daa88e3330c8a033cc7797d46b6cb59@sha256:d82e5d069979c6f57e5c2248ca5e853d9276689e3f8a75eef3346318e43680a4',
					running: true,
					environment: {},
					appId: 1032480,
					releaseId: 990450,
					serviceId: 29396,
					commit: '3f80bb77c68680c685fb67006d3d2e90',
				},
			]),
		});
	});
});
