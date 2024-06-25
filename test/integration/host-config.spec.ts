import { expect } from 'chai';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import * as path from 'path';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import * as fs from 'fs/promises';

import * as hostConfig from '~/src/host-config';
import * as config from '~/src/config';
import * as applicationManager from '~/src/compose/application-manager';
import type { InstancedAppState } from '~/src/compose/types';
import * as updateLock from '~/lib/update-lock';
import { UpdatesLockedError } from '~/lib/errors';
import * as dbus from '~/lib/dbus';
import { pathOnBoot, pathOnRoot } from '~/lib/host-utils';
import {
	createApps,
	createService,
	DEFAULT_NETWORK,
} from '~/test-lib/state-helper';

describe('host-config', () => {
	let tFs: TestFs.Disabled;
	let currentApps: InstancedAppState;
	const APP_ID = 1;
	const SERVICE_NAME = 'one';
	const proxyBase = pathOnBoot('system-proxy');
	const redsocksConf = path.join(proxyBase, 'redsocks.conf');
	const noProxy = path.join(proxyBase, 'no_proxy');
	const hostname = pathOnRoot('/etc/hostname');
	const appLockDir = pathOnRoot(updateLock.lockPath(APP_ID));

	before(async () => {
		await config.initialized();

		// Create current state
		currentApps = createApps(
			{
				services: [
					await createService({
						running: true,
						appId: APP_ID,
						serviceName: SERVICE_NAME,
					}),
				],
				networks: [DEFAULT_NETWORK],
			},
			false,
		);

		// Set up test fs
		tFs = testfs({
			[redsocksConf]: testfs.from(
				'test/data/mnt/boot/system-proxy/redsocks.conf',
			),
			[noProxy]: testfs.from('test/data/mnt/boot/system-proxy/no_proxy'),
			[hostname]: 'deadbeef',
			// Create a lock. This won't prevent host config patch unless
			// there are current apps present, in which case an updates locked
			// error will be thrown.
			[appLockDir]: {
				[SERVICE_NAME]: {
					'updates.lock': '',
				},
			},
		});
	});

	beforeEach(async () => {
		await tFs.enable();
		// Stub external dependencies
		stub(dbus, 'servicePartOf').resolves([]);
		stub(dbus, 'restartService').resolves();
	});

	afterEach(async () => {
		await tFs.restore();
		(dbus.servicePartOf as SinonStub).restore();
		(dbus.restartService as SinonStub).restore();
	});

	it('reads proxy config, dns config, and hostname', async () => {
		const { network } = await hostConfig.get();
		expect(network).to.have.property('hostname', 'deadbeef');
		expect(network).to.have.property('proxy');
		expect(network.proxy).to.have.property('ip', 'example.org');
		expect(network.proxy).to.have.property('port', 1080);
		expect(network.proxy).to.have.property('type', 'socks5');
		expect(network.proxy).to.have.property('login', 'foo');
		expect(network.proxy).to.have.property('password', 'bar');
		expect(network.proxy).to.have.deep.property('noProxy', [
			'152.10.30.4',
			'253.1.1.0/16',
		]);
		expect(network).to.have.property('dns');
		expect(network.dns).to.have.property('remoteIp', '1.2.3.4');
		expect(network.dns).to.have.property('remotePort', '54');
	});

	it('prevents patch if update locks are present', async () => {
		stub(applicationManager, 'getCurrentApps').resolves(currentApps);

		try {
			await hostConfig.patch({ network: { hostname: 'test' } });
			expect.fail('Expected hostConfig.patch to throw UpdatesLockedError');
		} catch (e: unknown) {
			expect(e).to.be.instanceOf(UpdatesLockedError);
		}

		(applicationManager.getCurrentApps as SinonStub).restore();
	});

	it('patches if update locks are present but force is specified', async () => {
		stub(applicationManager, 'getCurrentApps').resolves(currentApps);

		try {
			await hostConfig.patch({ network: { hostname: 'deadreef' } }, true);
			expect(await config.get('hostname')).to.equal('deadreef');
		} catch (e: unknown) {
			expect.fail(`Expected hostConfig.patch to not throw, but got ${e}`);
		}

		(applicationManager.getCurrentApps as SinonStub).restore();
	});

	it('patches hostname', async () => {
		await hostConfig.patch({ network: { hostname: 'test' } });
		// /etc/hostname isn't changed until the balena-hostname service
		// is restarted by the OS.
		expect(await config.get('hostname')).to.equal('test');
	});

	describe('proxy', () => {
		// Reset to defaults before each test
		beforeEach(async () => {
			await hostConfig.patch({
				network: {
					proxy: {
						ip: 'example2.org',
						port: 1090,
						type: 'http-relay',
						login: 'bar',
						password: 'foo',
						noProxy: ['balena.io', '222.22.2.2'],
					},
				},
			});
		});

		it('patches proxy successfully (sanity check)', async () => {
			const { network } = await hostConfig.get();
			expect(network)
				.to.have.property('proxy')
				.that.deep.equals({
					ip: 'example2.org',
					port: 1090,
					type: 'http-relay',
					login: 'bar',
					password: 'foo',
					noProxy: ['balena.io', '222.22.2.2'],
				});
		});

		it('keeps current proxy if only noProxy is in target config', async () => {
			await hostConfig.patch({
				network: {
					proxy: {
						noProxy: ['balena-cloud.com'],
					},
				},
			});
			const { network } = await hostConfig.get();
			expect(network)
				.to.have.property('proxy')
				.that.deep.equals({
					ip: 'example2.org',
					port: 1090,
					type: 'http-relay',
					login: 'bar',
					password: 'foo',
					noProxy: ['balena-cloud.com'],
				});
		});

		it('keeps current proxy when a patch does not include any proxy changes', async () => {
			const { network } = await hostConfig.get();
			expect(network)
				.to.have.property('proxy')
				.that.deep.equals({
					ip: 'example2.org',
					port: 1090,
					type: 'http-relay',
					login: 'bar',
					password: 'foo',
					noProxy: ['balena.io', '222.22.2.2'],
				});

			// Patch something unrelated
			await hostConfig.patch({
				network: {
					hostname: 'test',
				},
			});
			const { network: n2 } = await hostConfig.get();
			expect(n2)
				.to.have.property('proxy')
				.that.deep.equals({
					ip: 'example2.org',
					port: 1090,
					type: 'http-relay',
					login: 'bar',
					password: 'foo',
					noProxy: ['balena.io', '222.22.2.2'],
				});
		});
	});

	describe('dns', () => {
		// Reset to defaults before each test
		beforeEach(async () => {
			await hostConfig.patch({
				network: {
					dns: '1.2.3.4:52',
				},
			});
		});

		it('patches dns successfully (sanity check)', async () => {
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '1.2.3.4',
				remotePort: '52',
			});
		});

		it('patches dns with defaults when provided boolean config (dns: true)', async () => {
			await hostConfig.patch({
				network: {
					dns: true,
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '8.8.8.8',
				remotePort: '53',
			});
		});

		it('removes dns when provided boolean config (dns: false)', async () => {
			await hostConfig.patch({
				network: {
					dns: false,
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.not.have.property('dns');
		});

		it('patches dns when provided valid string config (dns: "remote_ip[:remote_port]")', async () => {
			await hostConfig.patch({
				network: {
					dns: '3.4.5.6:56',
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '3.4.5.6',
				remotePort: '56',
			});
		});

		it('patches with default ip and port if provided empty string', async () => {
			await hostConfig.patch({
				network: {
					dns: '',
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '8.8.8.8',
				remotePort: '53',
			});
		});

		it('patches with default ip if not provided', async () => {
			await hostConfig.patch({
				network: {
					dns: false,
				},
			});
			await hostConfig.patch({
				network: {
					dns: ':57',
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '8.8.8.8',
				remotePort: '57',
			});
		});

		it('patches with default port if not provided', async () => {
			await hostConfig.patch({
				network: {
					dns: false,
				},
			});
			await hostConfig.patch({
				network: {
					dns: '4.5.6.7',
				},
			});
			const { network: n2 } = await hostConfig.get();
			expect(n2).to.have.property('dns').that.deep.equals({
				remoteIp: '4.5.6.7',
				remotePort: '53',
			});
		});

		it('does not modify dns configs when patch does not include dns', async () => {
			// Set dns
			await hostConfig.patch({
				network: {
					dns: true,
				},
			});
			const { network } = await hostConfig.get();
			expect(network).to.have.property('dns').that.deep.equals({
				remoteIp: '8.8.8.8',
				remotePort: '53',
			});

			// Patch something else that's unrelated
			await hostConfig.patch({
				network: {
					proxy: {
						ip: 'example2.org',
						port: 1090,
						type: 'http-relay',
					},
				},
			});
			const { network: n2 } = await hostConfig.get();
			expect(n2).to.have.property('dns').that.deep.equals({
				remoteIp: '8.8.8.8',
				remotePort: '53',
			});
		});
	});

	it('skips restarting proxy services when part of redsocks-conf.target', async () => {
		(dbus.servicePartOf as SinonStub).resolves(['redsocks-conf.target']);
		await hostConfig.patch({
			network: {
				proxy: {
					ip: 'example2.org',
					port: 1090,
					type: 'http-relay',
					login: 'bar',
					password: 'foo',
					noProxy: ['balena.io', '222.22.2.2'],
				},
			},
		});
		expect(dbus.restartService as SinonStub).to.not.have.been.called;
		const { network } = await hostConfig.get();
		expect(network).to.have.property('proxy');
		expect(network.proxy).to.have.property('ip', 'example2.org');
		expect(network.proxy).to.have.property('port', 1090);
		expect(network.proxy).to.have.property('type', 'http-relay');
		expect(network.proxy).to.have.property('login', 'bar');
		expect(network.proxy).to.have.property('password', 'foo');
		expect(network.proxy).to.have.deep.property('noProxy', [
			'balena.io',
			'222.22.2.2',
		]);
	});

	it('patches redsocks.conf to be empty if prompted', async () => {
		await hostConfig.patch({ network: { proxy: {}, dns: false } });
		const { network } = await hostConfig.get();
		expect(network).to.not.have.property('proxy');
		expect(network).to.not.have.property('dns');
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);
	});

	it('patches no_proxy to be empty if prompted', async () => {
		await hostConfig.patch({
			network: {
				proxy: {
					noProxy: [],
				},
			},
		});
		const { network } = await hostConfig.get();
		expect(network).to.have.property('proxy');
		expect(network.proxy).to.not.have.property('noProxy');
		expect(await fs.readdir(proxyBase)).to.not.have.members(['no_proxy']);
	});

	it("doesn't update hostname, proxy, or dns when all are empty", async () => {
		const { network } = await hostConfig.get();
		await hostConfig.patch({ network: {} });
		const { network: newNetwork } = await hostConfig.get();
		expect(network.hostname).to.equal(newNetwork.hostname);
		expect(network.proxy).to.deep.equal(newNetwork.proxy);
		expect(network.dns).to.deep.equal(newNetwork.dns);
	});
});
