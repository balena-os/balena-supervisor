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
	const defaultConf = {
		proxy: {
			ip: 'example.org',
			port: 1080,
			type: 'socks5',
			login: 'foo',
			password: 'bar',
			dns: '1.2.3.4:54',
			noProxy: ['152.10.30.4', '253.1.1.0/16'],
		},
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

	it('patches proxy if update locks are present but force is specified', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		try {
			await patch({ network: { proxy: {} } }, true);
		} catch (e: unknown) {
			expect.fail(`Expected hostConfig.patch to not throw, but got ${e}`);
		}
		// Proxy should have been deleted as proxy was patched to empty,
		// hostname should remain unchanged
		const { network } = await get();
		expect(network).to.deep.equal({
			hostname: defaultConf.hostname,
		});
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('prevents hostname patch if there are update locks', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		await expect(patch({ network: { hostname: 'test' } }, true)).to.not.be
			.rejected;
		// /etc/hostname isn't changed until the balena-hostname service
		// is restarted by the OS.
		expect(await config.get('hostname')).to.equal('test');
	});

	it('patches hostname if update locks are present but force is specified', async () => {
		(applicationManager.getCurrentApps as SinonStub).resolves(currentApps);

		await expect(patch({ network: { hostname: 'test' } })).to.be.rejected;
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
	});

	it('patches hostname without modifying other fields', async () => {
		await patch({ network: { hostname: 'test' } });
		// /etc/hostname isn't changed until the balena-hostname service
		// is restarted by the OS.
		expect(await config.get('hostname')).to.equal('test');
		// Proxy should remain unchanged as patch didn't include it
		const { network } = await get();
		expect(network.proxy).to.deep.equal(defaultConf.proxy);
	});

	it('patches proxy without modifying other fields', async () => {
		const newProxy = {
			ip: 'example2.org',
			port: 1090,
			type: 'http-relay',
			login: 'bar',
			password: 'foo',
			dns: '2.2.2.2:52',
			noProxy: ['balena.io', '222.22.2.2'],
		};
		await patch({ network: { proxy: newProxy } });
		const { network } = await get();
		expect(network).to.deep.equal({
			proxy: {
				...defaultConf.proxy,
				...newProxy,
			},
			hostname: defaultConf.hostname,
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
					type = http-relay;
					login = "bar";
					password = "foo";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 2.2.2.2;
					remote_port = 52;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);

		expect(await fs.readFile(noProxy, 'utf-8')).to.equal(stripIndent`
			balena.io
			222.22.2.2
		`);
	});

	it('patches proxy fields specified while leaving unspecified fields unchanged', async () => {
		const newProxyFields = {
			ip: 'example2.org',
			port: 1090,
		};
		await patch({
			network: {
				proxy: newProxyFields,
			},
		});
		const { network } = await get();
		expect(network).to.deep.equal({
			proxy: {
				...defaultConf.proxy,
				...newProxyFields,
			},
			hostname: defaultConf.hostname,
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
				}

				dnsu2t {
					remote_ip = 1.2.3.4;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
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
		expect(network).to.deep.equal({
			hostname: defaultConf.hostname,
		});
	});

	it('keeps current proxy if input is invalid', async () => {
		await patch({ network: { proxy: null as any } });
		const { network } = await get();
		expect(network).to.deep.equal(defaultConf);
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
		const newProxy = {
			ip: 'example2.org',
			port: 1090,
			type: 'http-relay',
			login: 'bar',
			password: 'foo',
			dns: '4.3.2.1:52',
			noProxy: ['balena.io', '222.22.2.2'],
		};
		await patch({
			network: {
				proxy: newProxy,
			},
		});
		expect(dbus.restartService as SinonStub).to.not.have.been.called;
		const { network } = await get();
		expect(network.proxy).to.deep.equal({
			...defaultConf.proxy,
			...newProxy,
		});
	});

	it('patches redsocks.conf to be empty', async () => {
		await patch({ network: { proxy: {} } });
		const { network } = await get();
		expect(network).to.deep.equal({
			hostname: defaultConf.hostname,
		});
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);
	});

	it('patches no_proxy to be empty', async () => {
		await patch({
			network: {
				proxy: {
					noProxy: [],
				},
			},
		});
		const { network } = await get();
		// If only noProxy is patched, redsocks.conf should remain unchanged
		expect(network).to.have.property('proxy').that.deep.equals({
			ip: 'example.org',
			port: 1080,
			type: 'socks5',
			login: 'foo',
			password: 'bar',
			dns: '1.2.3.4:54',
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
					ip = example.org;
					port = 1080;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 1.2.3.4;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);
		expect(network.proxy).to.not.have.property('noProxy');
		expect(await fs.readdir(proxyBase)).to.not.have.members(['no_proxy']);
	});

	it("doesn't update hostname or proxy when both are empty", async () => {
		const { network } = await get();
		await patch({ network: {} });
		const { network: newNetwork } = await get();
		expect(network.hostname).to.equal(newNetwork.hostname);
		expect(network.proxy).to.deep.equal(newNetwork.proxy);
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
					ip = example.org;
					port = 1080;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 1.2.3.4;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);
	});

	it('patches dnsu2t config to default without modifying other fields', async () => {
		await patch({
			network: {
				proxy: {
					dns: true,
				},
			},
		});
		const { network } = await get();
		expect(network.proxy).to.deep.equal({
			...defaultConf.proxy,
			dns: '8.8.8.8:53',
		});
		expect(await config.get('hostname')).to.equal(defaultConf.hostname);
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
					ip = example.org;
					port = 1080;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 8.8.8.8;
					remote_port = 53;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);
	});

	it('patches dnsu2t config to string value', async () => {
		await patch({
			network: {
				proxy: {
					dns: '4.3.2.1:51',
				},
			},
		});
		const { network } = await get();
		expect(network.proxy).to.deep.equal({
			...defaultConf.proxy,
			dns: '4.3.2.1:51',
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
					ip = example.org;
					port = 1080;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 4.3.2.1;
					remote_port = 51;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);
	});

	it('patches dnsu2t config to empty', async () => {
		await patch({
			network: {
				proxy: {
					dns: false,
				},
			},
		});
		const { network } = await get();
		const { dns, ...proxyWithoutDns } = defaultConf.proxy;
		expect(network.proxy).to.deep.equal(proxyWithoutDns);
	});

	it('adds dnsu2t config to config without dnsu2t when provided valid input', async () => {
		// Delete dns config to set up test
		await patch({
			network: {
				proxy: {
					dns: false,
				},
			},
		});
		const { network } = await get();
		expect(network.proxy).to.not.have.property('dns');
		expect(await fs.readFile(redsocksConf, 'utf-8')).to.not.contain('dnsu2t');

		// Add valid dns config
		await patch({
			network: {
				proxy: {
					dns: '5.5.5.5:55',
				},
			},
		});
		const { network: n2 } = await get();
		expect(n2.proxy).to.deep.equal({
			...defaultConf.proxy,
			dns: '5.5.5.5:55',
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
					ip = example.org;
					port = 1080;
					type = socks5;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 5.5.5.5;
					remote_port = 55;
					local_ip = 127.0.0.1;
					local_port = 53;
				}` + '\n',
		);
	});

	it("does not add dnsu2t config when redsocks proxy isn't configured", async () => {
		// Delete redsocks config to set up test
		await patch({
			network: {
				proxy: {},
			},
		});
		const { network } = await get();
		expect(network).to.not.have.property('proxy');
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);

		// Add valid dns config
		await patch({
			network: {
				proxy: {
					dns: '1.2.3.4:54',
				},
			},
		});
		const { network: n2 } = await get();
		expect(n2).to.deep.equal({
			hostname: defaultConf.hostname,
		});
		expect(await fs.readdir(proxyBase)).to.not.have.members([
			'redsocks.conf',
			'no_proxy',
		]);
	});
});
