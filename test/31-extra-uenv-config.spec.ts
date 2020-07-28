import { child_process, fs } from 'mz';
import { stripIndent } from 'common-tags';
import { SinonStub, spy, stub } from 'sinon';

import { expect } from './lib/chai-config';
import * as fsUtils from '../src/lib/fs-utils';
import Log from '../src/lib/supervisor-console';
import { ExtraUEnvConfigBackend } from '../src/config/backends/extra-uEnv';

describe('extra_uEnv Configuration', () => {
	const backend = new ExtraUEnvConfigBackend();
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
		const parsed = ExtraUEnvConfigBackend.parseOptions(fileContents);
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

	it('only matches supported devices', () => {
		MATCH_TESTS.forEach(({ deviceType, metaRelease, supported }) =>
			expect(backend.matches(deviceType, metaRelease)).to.equal(supported),
		);
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
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(child_process, 'exec').resolves();
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

		expect(fsUtils.writeFileAtomic).to.be.calledWith(
			'./test/data/mnt/boot/extra_uEnv.txt',
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2\n',
		);

		expect(logWarningStub.lastCall?.lastArg).to.equal(
			'Not setting unsupported value: { console: tty0 }',
		);

		// Restore stubs
		(fsUtils.writeFileAtomic as SinonStub).restore();
		(child_process.exec as SinonStub).restore();
		logWarningStub.restore();
	});

	it('sets new config values containing collections', async () => {
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(child_process, 'exec').resolves();
		const logWarningStub = spy(Log, 'warn');

		// @ts-ignore accessing private value
		const previousSupportedConfigs = ExtraUEnvConfigBackend.supportedConfigs;
		// Stub isSupportedConfig so we can confirm collections work
		// @ts-ignore accessing private value
		ExtraUEnvConfigBackend.supportedConfigs = {
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

		expect(fsUtils.writeFileAtomic).to.be.calledWith(
			'./test/data/mnt/boot/extra_uEnv.txt',
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2 console=tty0 splash\n',
		);

		// Restore stubs
		(fsUtils.writeFileAtomic as SinonStub).restore();
		(child_process.exec as SinonStub).restore();
		logWarningStub.restore();
		// @ts-ignore accessing private value
		ExtraUEnvConfigBackend.supportedConfigs = previousSupportedConfigs;
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

const SUPPORTED_VERSION = '2.47.0'; // or greater
const UNSUPPORTED_VERSION = '2.45.0'; // or less

const MATCH_TESTS = [
	{
		deviceType: 'jetson-tx1',
		metaRelease: SUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'jetson-tx2',
		metaRelease: SUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'jetson-tx2',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'jetson-nano',
		metaRelease: SUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'jetson-nano',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'jetson-xavier',
		metaRelease: SUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'jetson-xavier',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'intel-nuc',
		metaRelease: SUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'intel-nuc',
		metaRelease: UNSUPPORTED_VERSION,
		supported: true,
	},
	{
		deviceType: 'raspberry',
		metaRelease: SUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'raspberry',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'fincm3',
		metaRelease: SUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'fincm3',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'up-board',
		metaRelease: SUPPORTED_VERSION,
		supported: false,
	},
	{
		deviceType: 'up-board',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
	},
];
