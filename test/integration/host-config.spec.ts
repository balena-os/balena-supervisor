import { expect } from 'chai';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import * as path from 'path';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import * as fs from 'fs/promises';

import { get, patch } from '~/src/host-config';
import {
	DEFAULT_REMOTE_IP,
	DEFAULT_REMOTE_PORT,
} from '~/src/host-config/proxy';
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

	const defaultConf = {
		proxy: {
			ip: 'example.org',
			port: 1080,
			type: 'socks5',
			login: 'foo',
			password: 'bar',
			noProxy: ['152.10.30.4', '253.1.1.0/16'],
		},
		dns: '1.2.3.4:54',
		hostname: 'deadbeef',
	};

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
			[hostname]: defaultConf.hostname,
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
		await config.set({ hostname: defaultConf.hostname });
		// Stub external dependencies
		stub(dbus, 'servicePartOf').resolves([]);
		stub(dbus, 'restartService').resolves();
		stub(applicationManager, 'getCurrentApps').resolves({});
	});

	afterEach(async () => {
		await tFs.restore();
		(dbus.servicePartOf as SinonStub).restore();
		(dbus.restartService as SinonStub).restore();
		(applicationManager.getCurrentApps as SinonStub).restore();
	});

	it('reads proxy configs and hostname', async () => {
		const { network } = await get();
		expect(network).to.deep.equal(defaultConf);
	});

	it('prevents patch if update locks are present', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		try {
			await patch({ network: { proxy: {} } });
			expect.fail('Expected hostConfig.patch to throw UpdatesLockedError');
		} catch (e: unknown) {
			expect(e).to.be.instanceOf(UpdatesLockedError);
		}
	});

	it('patches if update locks are present but force is specified', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		try {
			await patch({ network: { proxy: {} } }, true);
		} catch (e: unknown) {
			expect.fail(`Expected hostConfig.patch to not throw, but got ${e}`);
		}
		// Proxy & dns should have been deleted as proxy was patched to empty,
		// hostname should remain unchanged
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(network).to.not.have.property('dns');
		expect(network)
			.to.have.property('hostname')
			.that.equals(defaultConf.hostname);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches hostname regardless of update locks', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		try {
			await patch({ network: { hostname: 'test' } });
			// /etc/hostname isn't changed until the balena-hostname service
			// is restarted by the OS.
			expect(await config.get('hostname')).to.equal('test');
		} catch (e: unknown) {
			expect.fail(`Expected hostConfig.patch to not throw, but got ${e}`);
		}
	});

	it('patches hostname without modifying other fields', async () => {
		await patch({ network: { hostname: 'test' } });
		// /etc/hostname isn't changed until the balena-hostname service
		// is restarted by the OS.
		expect(await config.get('hostname')).to.equal('test');
		const { network } = await get();
		// Proxy & dns should remain unchanged as patch didn't include it
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
	});

	it('patches proxy without modifying other fields', async () => {
		const proxy = {
			ip: 'example2.org',
			port: 1090,
			type: 'http-relay',
			login: 'bar',
			password: 'foo',
			noProxy: ['balena.io', '222.22.2.2'],
		};
		await patch({
			network: {
				proxy,
			},
		});
		const { network } = await get();
		expect(network).to.have.property('proxy').that.deep.equals(proxy);
		// Dns & hostname should remain unchanged as patch didn't include it
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches proxy fields specified while leaving unspecified fields unchanged', async () => {
		const proxy = {
			ip: 'example2.org',
			port: 1090,
		};
		await patch({
			network: {
				proxy,
			},
		});
		const { network } = await get();
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals({
				...defaultConf.proxy,
				...proxy,
			});
		// Dns & hostname should remain unchanged as patch didn't include it
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches proxy and dns to empty', async () => {
		await patch({ network: { proxy: {} } });
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(network).to.not.have.property('dns');
		// Hostname should remain unchanged
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	// Dns config depends on redsocks proxy config to work, so should be deleted if proxy is deleted
	it('patches proxy and dns to empty if input proxy is empty, regardless of input dns', async () => {
		await patch({ network: { proxy: {}, dns: '1.1.1.1:52' } });
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(network).to.not.have.property('dns');
		// Hostname should remain unchanged
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches dns to empty if input dns is empty, regardless of input proxy', async () => {
		const proxy = {
			ip: 'example2.org',
			port: 1090,
			type: 'http-relay',
			login: 'bar',
			password: 'foo',
			noProxy: ['balena.io'],
		};
		await patch({
			network: {
				proxy,
				dns: false,
			},
		});
		const { network } = await get();
		expect(network).to.not.have.property('dns');
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals({
				...defaultConf.proxy,
				...proxy,
			});
		// Hostname should remain unchanged
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('does not add dns to currently dns-less config if provided `dns: false`', async () => {
		// Remove dns from current config
		await patch({ network: { dns: false } });
		const { network: n1 } = await get();
		expect(n1).to.not.have.property('dns');
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(n1).to.have.property('proxy').that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);

		// Patch with dns: false
		await patch({ network: { dns: false } });
		const { network: n2 } = await get();
		expect(n2).to.not.have.property('dns');
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(n2).to.have.property('proxy').that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('does not add dns to currently proxy-less config if provided `dns: true` or `dns: [IP][:PORT]`', async () => {
		// Remove proxy from current config
		await patch({ network: { proxy: {} } });
		const { network: n1 } = await get();
		expect(n1).to.not.have.property('proxy');
		expect(n1).to.not.have.property('dns');
		// Hostname should remain unchanged as patch didn't include it
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);

		// Patch with dns: true
		await patch({ network: { dns: true } });
		const { network: n2 } = await get();
		expect(n2).to.not.have.property('proxy');
		expect(n2).to.not.have.property('dns');
		// Hostname should remain unchanged as patch didn't include it
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);

		// Patch with dns: [IP][:PORT]
		await patch({ network: { dns: '6.6.6.6:66' } });
		const { network: n3 } = await get();
		expect(n3).to.not.have.property('proxy');
		expect(n3).to.not.have.property('dns');
		// Hostname should remain unchanged as patch didn't include it
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('keeps current proxy if input is invalid', async () => {
		await patch({ network: { proxy: null as any, dns: null as any } });
		const { network } = await get();
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches dns without modifying other fields', async () => {
		await patch({ network: { dns: true } });
		const { network } = await get();
		expect(network)
			.to.have.property('dns')
			.that.equals(`${DEFAULT_REMOTE_IP}:${DEFAULT_REMOTE_PORT}`);
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches dns when given a string input', async () => {
		await patch({ network: { dns: '3.3.3.3:56' } });
		const { network } = await get();
		expect(network).to.have.property('dns').that.equals('3.3.3.3:56');
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it("patches dns to default for any part of string input [IP][:PORT] that's missing", async () => {
		await patch({ network: { dns: ':56' } });
		const { network: n1 } = await get();
		expect(n1).to.have.property('dns').that.equals(`${DEFAULT_REMOTE_IP}:56`);
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(n1).to.have.property('proxy').that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);

		await patch({ network: { dns: '7.7.7.7' } });
		const { network: n2 } = await get();
		expect(n2)
			.to.have.property('dns')
			.that.equals(`7.7.7.7:${DEFAULT_REMOTE_PORT}`);
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(n2).to.have.property('proxy').that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);

		await patch({ network: { dns: '' } });
		const { network: n3 } = await get();
		expect(n3)
			.to.have.property('dns')
			.that.equals(`${DEFAULT_REMOTE_IP}:${DEFAULT_REMOTE_PORT}`);
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(n3).to.have.property('proxy').that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('removes dns if patched to be false', async () => {
		await patch({ network: { dns: false } });
		const { network } = await get();
		expect(network).to.not.have.property('dns');
		// Proxy & hostname should remain unchanged as patch didn't include it
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('skips restarting proxy services when part of redsocks-conf.target', async () => {
		(dbus.servicePartOf as SinonStub).resolves(['redsocks-conf.target']);
		const proxy = {
			ip: 'example2.org',
			port: 1090,
			type: 'http-relay',
			login: 'bar',
			password: 'foo',
			noProxy: ['balena.io', '222.22.2.2'],
		};
		await patch({
			network: {
				proxy,
			},
		});
		expect(dbus.restartService as SinonStub).to.not.have.been.called;
		const { network } = await get();
		expect(network).to.have.property('proxy').that.deep.equals(proxy);
		// Dns & hostname should remain unchanged
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('removes redsocks.conf if patched to be empty', async () => {
		await patch({ network: { proxy: {} } });
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(network).to.not.have.property('dns');
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);
		// Hostname should remain unchanged
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('removes no_proxy if patched to be empty', async () => {
		await patch({
			network: {
				proxy: {
					noProxy: [],
				},
			},
		});
		const { network } = await get();
		// If only noProxy is patched, redsocks.conf should remain unchanged
		expect(network).to.have.property('proxy').that.deep.includes({
			ip: 'example.org',
			port: 1080,
			type: 'socks5',
			login: 'foo',
			password: 'bar',
		});
		expect(network.proxy).to.not.have.property('noProxy');
		expect(await fs.readdir(proxyBase)).to.not.have.members(['no_proxy']);
		// Dns & hostname should also remain unchanged
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it("doesn't update hostname or proxy when both are empty", async () => {
		await patch({ network: {} });
		const { network } = await get();
		// Proxy, dns, and hostname should remain unchanged
		expect(network)
			.to.have.property('proxy')
			.that.deep.equals(defaultConf.proxy);
		expect(network).to.have.property('dns').that.equals(defaultConf.dns);
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});
});
