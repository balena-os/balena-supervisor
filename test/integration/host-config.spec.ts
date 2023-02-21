import { expect } from 'chai';
import { testfs, TestFs } from 'mocha-pod';
import * as path from 'path';
import { SinonStub, stub } from 'sinon';
import * as fs from 'fs/promises';

import * as hostConfig from '~/src/host-config';
import * as config from '~/src/config';
import * as applicationManager from '~/src/compose/application-manager';
import { InstancedAppState } from '~/src/types/state';
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
		stub(dbus, 'servicePartOf').resolves('');
		stub(dbus, 'restartService').resolves();
	});

	afterEach(async () => {
		await tFs.restore();
		(dbus.servicePartOf as SinonStub).restore();
		(dbus.restartService as SinonStub).restore();
	});

	it('reads proxy configs and hostname', async () => {
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
		// is restarted through dbus, so we verify the change from config.
		expect(await config.get('hostname')).to.equal('test');
	});

	it('skips restarting hostname services if they are part of config-json.target', async () => {
		(dbus.servicePartOf as SinonStub).resolves('config-json.target');
		await hostConfig.patch({ network: { hostname: 'newdevice' } });
		expect(dbus.restartService as SinonStub).to.not.have.been.called;
		expect(await config.get('hostname')).to.equal('newdevice');
	});

	it('patches proxy', async () => {
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

	it('skips restarting proxy services when part of redsocks-conf.target', async () => {
		(dbus.servicePartOf as SinonStub).resolves('redsocks-conf.target');
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
		await hostConfig.patch({ network: { proxy: {} } });
		const { network } = await hostConfig.get();
		expect(network).to.have.property('proxy', undefined);
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

	it("doesn't update hostname or proxy when both are empty", async () => {
		const { network } = await hostConfig.get();
		await hostConfig.patch({ network: {} });
		const { network: newNetwork } = await hostConfig.get();
		expect(network.hostname).to.equal(newNetwork.hostname);
		expect(network.proxy).to.deep.equal(newNetwork.proxy);
	});
});
