import { promises as fs } from 'fs';
import { stripIndent } from 'common-tags';
import { SinonStub, spy, stub } from 'sinon';
import { expect } from 'chai';

import * as fsUtils from '../src/lib/fs-utils';
import Log from '../src/lib/supervisor-console';
import { ExtraUEnv } from '../src/config/backends/extra-uEnv';

describe('extra_uEnv Configuration', () => {
	const backend = new ExtraUEnv();
	let readFileStub: SinonStub;

	beforeEach(() => {
		readFileStub = stub(fs, 'readFile');
	});

	afterEach(() => {
		readFileStub.restore();
	});

	it('should parse extra_uEnv string', () => {
		const fileContents = stripIndent`\
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4 splash console=tty0
		`;
		// @ts-ignore accessing private method
		const parsed = ExtraUEnv.parseOptions(fileContents);
		expect(parsed).to.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
			splash: '',
			console: 'tty0',
		});
	});

	it('should only parse supported configuration options from bootConfigPath', async () => {
		readFileStub.resolves(stripIndent`\
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4
    `);

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
		});

		// Add other options that will get filtered out because they aren't supported
		readFileStub.resolves(stripIndent`\
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4 console=tty0 splash
    `);

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
		});

		// Stub with no supported values
		readFileStub.resolves(stripIndent`\
			fdt=something_else
			isolcpus
			123.12=5
		`);

		await expect(backend.getBootConfig()).to.eventually.deep.equal({});
	});

	it('only matches supported devices', async () => {
		const existsStub = stub(fsUtils, 'exists');
		for (const device of MATCH_TESTS) {
			// Test device that has extra_uEnv.txt
			let hasExtraUEnv = true;
			existsStub.resolves(hasExtraUEnv);
			await expect(backend.matches(device.type)).to.eventually.equal(
				device.supported && hasExtraUEnv,
			);
			// Test same device but without extra_uEnv.txt
			hasExtraUEnv = false;
			existsStub.resolves(hasExtraUEnv);
			await expect(backend.matches(device.type)).to.eventually.equal(
				device.supported && hasExtraUEnv,
			);
		}
		existsStub.restore();
	});

	it('errors when cannot find extra_uEnv.txt', async () => {
		// Stub readFile to reject much like if the file didn't exist
		readFileStub.rejects();
		await expect(backend.getBootConfig()).to.eventually.be.rejectedWith(
			'Could not find extra_uEnv file. Device is possibly bricked',
		);
	});

	it('logs warning for malformed extra_uEnv.txt', async () => {
		spy(Log, 'warn');
		for (const badConfig of MALFORMED_CONFIGS) {
			// Stub bad config
			readFileStub.resolves(badConfig.contents);
			// Expect warning log from the given bad config
			await backend.getBootConfig();
			// @ts-ignore
			expect(Log.warn.lastCall?.lastArg).to.equal(badConfig.reason);
		}
		// @ts-ignore
		Log.warn.restore();
	});

	it('sets new config values', async () => {
		stub(fsUtils, 'writeAndSyncFile').resolves();
		const logWarningStub = spy(Log, 'warn');

		// This config contains a value set from something else
		// We to make sure the Supervisor is enforcing the source of truth (the cloud)
		// So after setting new values this unsupported/not set value should be gone
		readFileStub.resolves(stripIndent`\
      extra_os_cmdline=rootwait isolcpus=3,4
      other_service=set_this_value
    `);

		// Sets config with mix of supported and not supported values
		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2',
			console: 'tty0', // not supported so won't be set
		});

		expect(fsUtils.writeAndSyncFile).to.be.calledWith(
			'test/data/mnt/boot/extra_uEnv.txt',
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2\n',
		);

		expect(logWarningStub.lastCall?.lastArg).to.equal(
			'Not setting unsupported value: { console: tty0 }',
		);

		// Restore stubs
		(fsUtils.writeAndSyncFile as SinonStub).restore();
		logWarningStub.restore();
	});

	it('sets new config values containing collections', async () => {
		stub(fsUtils, 'writeAndSyncFile').resolves();
		const logWarningStub = spy(Log, 'warn');

		// @ts-ignore accessing private value
		const previousSupportedConfigs = ExtraUEnv.supportedConfigs;
		// Stub isSupportedConfig so we can confirm collections work
		// @ts-ignore accessing private value
		ExtraUEnv.supportedConfigs = {
			fdt: { key: 'custom_fdt_file', collection: false },
			isolcpus: { key: 'extra_os_cmdline', collection: true },
			console: { key: 'extra_os_cmdline', collection: true },
			splash: { key: 'extra_os_cmdline', collection: true },
		};

		// Set config again
		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2', // collection entry so should be concatted to other collections of this entry
			console: 'tty0', // collection entry so should be concatted to other collections of this entry
			splash: '', // collection entry so should be concatted to other collections of this entry
		});

		expect(fsUtils.writeAndSyncFile).to.be.calledWith(
			'test/data/mnt/boot/extra_uEnv.txt',
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2 console=tty0 splash\n',
		);

		// Restore stubs
		(fsUtils.writeAndSyncFile as SinonStub).restore();
		logWarningStub.restore();
		// @ts-ignore accessing private value
		ExtraUEnv.supportedConfigs = previousSupportedConfigs;
	});

	it('only allows supported configuration options', () => {
		[
			{ configName: 'fdt', supported: true },
			{ configName: 'isolcpus', supported: true },
			{ configName: 'custom_fdt_file', supported: false },
			{ configName: 'splash', supported: false },
			{ configName: '', supported: false },
		].forEach(({ configName, supported }) =>
			expect(backend.isSupportedConfig(configName)).to.equal(supported),
		);
	});

	it('correctly detects boot config variables', () => {
		[
			{ config: 'HOST_EXTLINUX_isolcpus', valid: true },
			{ config: 'HOST_EXTLINUX_fdt', valid: true },
			{ config: 'HOST_EXTLINUX_rootwait', valid: true },
			{ config: 'HOST_EXTLINUX_5', valid: true },
			{ config: 'DEVICE_EXTLINUX_isolcpus', valid: false },
			{ config: 'isolcpus', valid: false },
		].forEach(({ config, valid }) =>
			expect(backend.isBootConfigVar(config)).to.equal(valid),
		);
	});

	it('converts variable to backend formatted name', () => {
		[
			{ input: 'HOST_EXTLINUX_isolcpus', output: 'isolcpus' },
			{ input: 'HOST_EXTLINUX_fdt', output: 'fdt' },
			{ input: 'HOST_EXTLINUX_', output: null },
			{ input: 'value', output: null },
		].forEach(({ input, output }) =>
			expect(backend.processConfigVarName(input)).to.equal(output),
		);
	});

	it('normalizes variable value', () => {
		[
			{ input: { key: 'key', value: 'value' }, output: 'value' },
		].forEach(({ input, output }) =>
			expect(backend.processConfigVarValue(input.key, input.value)).to.equal(
				output,
			),
		);
	});

	it('returns the environment name for config variable', () => {
		[
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: null },
		].forEach(({ input, output }) =>
			expect(backend.createConfigVarName(input)).to.equal(output),
		);
	});
});

const MALFORMED_CONFIGS = [
	{
		contents: stripIndent`
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4
      another_value
    `,
		reason: 'Could not read extra_uEnv entry: another_value',
	},
];

const MATCH_TESTS = [
	{ type: 'astro-tx2', supported: true },
	{ type: 'blackboard-tx2', supported: true },
	{ type: 'jetson-tx2', supported: true },
	{ type: 'n310-tx2', supported: true },
	{ type: 'n510-tx2', supported: true },
	{ type: 'orbitty-tx2', supported: true },
	{ type: 'spacely-tx2', supported: true },
	{ type: 'srd3-tx2', supported: true },
	{ type: 'jetson-nano', supported: true },
	{ type: 'jetson-nano-emmc', supported: true },
	{ type: 'jn30b-nano', supported: true },
	{ type: 'photon-nano', supported: true },
	{ type: 'intel-nuc', supported: false },
	{ type: 'raspberry', supported: false },
	{ type: 'fincm3', supported: false },
	{ type: 'asus-tinker-board', supported: false },
	{ type: 'nano-board', supported: false },
	{ type: 'jetson-nano-2gb-devkit', supported: true },
	{ type: 'jetson-nano-2gb-devkit-emmc', supported: false },
	{ type: 'tx2-tx2-device', supported: false },
	{ type: 'jetson-tx2-nx-devkit', supported: true },
	{ type: 'photon-tx2-nx', supported: true },
	{ type: 'jetson-xavier-nx-devkit', supported: false },
	{ type: 'photon-xavier-nx', supported: false },
	{ type: 'imx8m-var-dart', supported: true },
	{ type: 'imx8mm-var-dart', supported: true },
	{ type: 'imx8mm-var-dart-nrt', supported: true },
	{ type: 'imx8mm-var-dart-plt', supported: true },
	{ type: 'imx6ul-var-dart', supported: false },
];
