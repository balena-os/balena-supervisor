import { expect } from 'chai';
import { stripIndent } from 'common-tags';
import type { TestFs } from 'mocha-pod';
import { testfs } from 'mocha-pod';
import * as path from 'path';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';
import * as fs from 'fs/promises';

import { get, patch } from '~/src/host-config';
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
		expect(await get()).to.deep.equal({ network: { hostname: 'deadbeef' } });
	});

	it('patches hostname regardless of update locks', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		try {
			await patch({ network: { hostname: 'test' } });
			expect(await config.get('hostname')).to.equal('test');
		} catch (e: unknown) {
			expect.fail(`Expected hostConfig.patch to not throw, but got ${e}`);
		}
	});

	it('patches hostname', async () => {
		await patch({ network: { hostname: 'test' } });
		// /etc/hostname isn't changed until the balena-hostname service
		// is restarted by the OS.
		expect(await config.get('hostname')).to.equal('test');
	});

	it('patches proxy', async () => {
		const newConf = {
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
		};
		await patch(newConf);
		const { network } = await get();
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

		await expect(fs.readFile(redsocksConf, 'utf-8')).to.eventually.equal(
			stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					ip = example2.org;
					port = 1090;
					type = http-relay;
					login = "bar";
					password = "foo";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}` + '\n',
		);

		expect(await fs.readFile(noProxy, 'utf-8')).to.equal(stripIndent`
			balena.io
			222.22.2.2
		`);
	});

	it('patches proxy fields specified while leaving unspecified fields unchanged', async () => {
		await patch({
			network: {
				proxy: {
					ip: 'example2.org',
					port: 1090,
				},
			},
		});
		const { network } = await get();
		expect(network).to.have.property('proxy');
		expect(network.proxy).to.have.property('ip', 'example2.org');
		expect(network.proxy).to.have.property('port', 1090);
		expect(network.proxy).to.have.property('type', 'socks5');
		expect(network.proxy).to.have.property('login', 'foo');
		expect(network.proxy).to.have.property('password', 'bar');
		expect(network.proxy).to.have.deep.property('noProxy', [
			'152.10.30.4',
			'253.1.1.0/16',
		]);

		await expect(fs.readFile(redsocksConf, 'utf-8')).to.eventually.equal(
			stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					ip = example2.org;
					port = 1090;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}` + '\n',
		);

		expect(await fs.readFile(noProxy, 'utf-8')).to.equal(
			stripIndent`
			152.10.30.4
			253.1.1.0/16
		` + '\n',
		);
	});

	it('patches proxy to empty if input is empty', async () => {
		await patch({ network: { proxy: {} } });
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
	});

	it('keeps current proxy if input is invalid', async () => {
		await patch({ network: { proxy: null as any } });
		const { network } = await get();
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

	it('ignores unsupported fields when patching proxy', async () => {
		const rawConf = await fs.readFile(redsocksConf, 'utf-8');
		await patch({
			network: {
				proxy: {
					local_ip: '127.0.0.2',
					local_port: 12346,
				} as any,
			},
		});
		expect(await fs.readFile(redsocksConf, 'utf-8')).to.equal(rawConf);
	});

	// Check that a bad configuration is fixed by a new patch
	it('ignores unsupported fields when reading proxy', async () => {
		const badConf =
			stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					ip = example2.org;
					port = 1090;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.2;
					local_port = 12345;
					noProxy = bad.server.com
				}` + '\n';

		await fs.writeFile(redsocksConf, badConf);
		await fs.writeFile(noProxy, 'bad.server.com');
		await expect(get()).to.eventually.deep.equal({
			network: {
				hostname: 'deadbeef',
				proxy: {
					ip: 'example2.org',
					port: 1090,
					type: 'socks5',
					login: 'foo',
					password: 'bar',
					noProxy: ['bad.server.com'],
				},
			},
		});

		await patch({
			network: {
				proxy: {
					ip: 'example2.org',
					noProxy: ['bad.server.com'],
				} as any,
			},
		});

		await expect(fs.readFile(redsocksConf, 'utf-8')).to.eventually.equal(
			stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					ip = example2.org;
					port = 1090;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}` + '\n',
		);
		expect(await fs.readFile(noProxy, 'utf-8')).to.equal(
			stripIndent`
				bad.server.com
			`,
		);
	});

	it('skips restarting proxy services when part of redsocks-conf.target', async () => {
		(dbus.servicePartOf as SinonStub).resolves(['redsocks-conf.target']);
		await patch({
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
		const { network } = await get();
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
		await patch({ network: { proxy: {} } });
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);
	});

	it('patches no_proxy to be empty if prompted', async () => {
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
	});

	it("doesn't update hostname or proxy when both are empty", async () => {
		const { network } = await get();
		await patch({ network: {} });
		const { network: newNetwork } = await get();
		expect(network.hostname).to.equal(newNetwork.hostname);
		expect(network.proxy).to.deep.equal(newNetwork.proxy);
	});
});
