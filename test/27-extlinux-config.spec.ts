import { promises as fs } from 'fs';
import { stripIndent } from 'common-tags';
import { SinonStub, stub } from 'sinon';
import { expect } from 'chai';

import * as fsUtils from '~/lib/fs-utils';
import { Extlinux } from '~/src/config/backends/extlinux';

describe('Extlinux Configuration', () => {
	const backend = new Extlinux();

	it('should parse a extlinux.conf file', () => {
		const text = stripIndent`\
			DEFAULT primary
			# CommentExtlinux files

			TIMEOUT 30
			MENU TITLE Boot Options
			LABEL primary
						MENU LABEL primary Image
						LINUX /Image
						FDT /boot/mycustomdtb.dtb
						APPEND \${cbootargs} \${resin_kernel_root} ro rootwait\
		`;

		// @ts-ignore accessing private method
		const parsed = Extlinux.parseExtlinuxFile(text);
		expect(parsed.globals).to.have.property('DEFAULT').that.equals('primary');
		expect(parsed.globals).to.have.property('TIMEOUT').that.equals('30');
		expect(parsed.globals)
			.to.have.property('MENU TITLE')
			.that.equals('Boot Options');

		expect(parsed.labels).to.have.property('primary');
		const { primary } = parsed.labels;
		expect(primary).to.have.property('MENU LABEL').that.equals('primary Image');
		expect(primary).to.have.property('LINUX').that.equals('/Image');
		expect(primary)
			.to.have.property('FDT')
			.that.equals('/boot/mycustomdtb.dtb');
		expect(primary)
			.to.have.property('APPEND')
			.that.equals('${cbootargs} ${resin_kernel_root} ro rootwait');
	});

	it('should parse multiple service entries', () => {
		const text = stripIndent`\
			DEFAULT primary
			# Comment

			TIMEOUT 30
			MENU TITLE Boot Options
			LABEL primary
						LINUX test1
						FDT /boot/mycustomdtb.dtb
						APPEND test2
			LABEL secondary
						LINUX test3
						FDT /boot/mycustomdtb.dtb
						APPEND test4\
		`;

		// @ts-ignore accessing private method
		const parsed = Extlinux.parseExtlinuxFile(text);
		expect(parsed.labels).to.have.property('primary').that.deep.equals({
			LINUX: 'test1',
			FDT: '/boot/mycustomdtb.dtb',
			APPEND: 'test2',
		});
		expect(parsed.labels).to.have.property('secondary').that.deep.equals({
			LINUX: 'test3',
			FDT: '/boot/mycustomdtb.dtb',
			APPEND: 'test4',
		});
	});

	it('should parse configuration options from an extlinux.conf file', async () => {
		let text = stripIndent`\
			DEFAULT primary
			# Comment

			TIMEOUT 30
			MENU TITLE Boot Options
			LABEL primary
						MENU LABEL primary Image
						LINUX /Image
						FDT /boot/mycustomdtb.dtb
						APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=3\
		`;

		let readFileStub = stub(fs, 'readFile').resolves(text);
		let parsed = backend.getBootConfig();

		await expect(parsed)
			.to.eventually.have.property('isolcpus')
			.that.equals('3');
		await expect(parsed)
			.to.eventually.have.property('fdt')
			.that.equals('/boot/mycustomdtb.dtb');
		readFileStub.restore();

		text = stripIndent`\
			DEFAULT primary
			# Comment

			TIMEOUT 30
			MENU TITLE Boot Options
			LABEL primary
						MENU LABEL primary Image
						LINUX /Image
						FDT /boot/mycustomdtb.dtb
						APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=3,4,5\
		`;
		readFileStub = stub(fs, 'readFile').resolves(text);

		parsed = backend.getBootConfig();

		readFileStub.restore();

		await expect(parsed)
			.to.eventually.have.property('isolcpus')
			.that.equals('3,4,5');
	});

	it('only matches supported devices', async () => {
		for (const { deviceType, metaRelease, supported } of MATCH_TESTS) {
			await expect(
				backend.matches(deviceType, metaRelease),
			).to.eventually.equal(supported);
		}
	});

	it('errors when cannot find extlinux.conf', async () => {
		// Stub readFile to reject much like if the file didn't exist
		stub(fs, 'readFile').rejects();
		await expect(backend.getBootConfig()).to.eventually.be.rejectedWith(
			'Could not find extlinux file. Device is possibly bricked',
		);
		// Restore stub
		(fs.readFile as SinonStub).restore();
	});

	it('throws error for malformed extlinux.conf', async () => {
		for (const badConfig of MALFORMED_CONFIGS) {
			// Stub bad config
			stub(fs, 'readFile').resolves(badConfig.contents);
			// Expect correct rejection from the given bad config
			try {
				await backend.getBootConfig();
			} catch (e) {
				expect(e.message).to.equal(badConfig.reason);
			}
			// Restore stub
			(fs.readFile as SinonStub).restore();
		}
	});

	it('parses supported config values from bootConfigPath', async () => {
		// Will try to parse /test/data/mnt/boot/extlinux/extlinux.conf
		await expect(backend.getBootConfig()).to.eventually.deep.equal({}); // None of the values are supported so returns empty

		// Stub readFile to return a config that has supported values
		stub(fs, 'readFile').resolves(stripIndent`
    DEFAULT primary
    TIMEOUT 30
		MENU TITLE Boot Options
    LABEL primary
					MENU LABEL primary Image
					LINUX /Image
					FDT /boot/mycustomdtb.dtb
          APPEND ro rootwait isolcpus=0,4
    `);

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			isolcpus: '0,4',
			fdt: '/boot/mycustomdtb.dtb',
		});

		// Restore stub
		(fs.readFile as SinonStub).restore();
	});

	it('sets new config values', async () => {
		stub(fsUtils, 'writeAndSyncFile').resolves();

		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2',
		});

		expect(fsUtils.writeAndSyncFile).to.be.calledWith(
			'test/data/mnt/boot/extlinux/extlinux.conf',
			stripIndent`
	      DEFAULT primary
	      TIMEOUT 30
	      MENU TITLE Boot Options
	      LABEL primary
							MENU LABEL primary Image
							LINUX /Image
							APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=2
							FDT /boot/mycustomdtb.dtb
	    ` + '\n', // add newline because stripIndent trims last newline
		);

		// Restore stubs
		(fsUtils.writeAndSyncFile as SinonStub).restore();
	});

	it('only allows supported configuration options', () => {
		[
			{ configName: 'isolcpus', supported: true },
			{ configName: 'fdt', supported: true },
			{ configName: '', supported: false },
			{ configName: 'ro', supported: false }, // not allowed to configure
			{ configName: 'rootwait', supported: false }, // not allowed to configure
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
			// TO-DO: { config: 'HOST_EXTLINUX', valid: false },
			// TO-DO: { config: 'HOST_EXTLINUX_', valid: false },
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
			{ input: 'HOST_EXTLINUX_rootwait', output: 'rootwait' },
			{ input: 'HOST_EXTLINUX_something_else', output: 'something_else' },
			{ input: 'HOST_EXTLINUX_', output: 'HOST_EXTLINUX_' },
			{ input: 'HOST_EXTLINUX_ ', output: ' ' },
			{ input: 'ROOT_EXTLINUX_isolcpus', output: 'ROOT_EXTLINUX_isolcpus' },
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
			{ input: '', output: 'HOST_EXTLINUX_' },
			{ input: '5', output: 'HOST_EXTLINUX_5' },
		].forEach(({ input, output }) =>
			expect(backend.createConfigVarName(input)).to.equal(output),
		);
	});
});

const MALFORMED_CONFIGS = [
	{
		contents: stripIndent`
    TIMEOUT 30
    MENU TITLE Boot Options
    LABEL primary
          MENU LABEL primary Image
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4
    `,
		reason: 'Could not find default entry for extlinux.conf file',
	},
	{
		contents: stripIndent`
    DEFAULT typo_oops
    TIMEOUT 30
    MENU TITLE Boot Options
    LABEL primary
          MENU LABEL primary Image
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4
    `,
		reason: 'Cannot find label entry (label: typo_oops) for extlinux.conf file',
	},
	{
		contents: stripIndent`
    DEFAULT primary
    TIMEOUT 30
    MENU TITLE Boot Options
    LABEL primary
          MENU LABEL primary Image
          LINUX /Image
    `,
		reason:
			'Could not find APPEND directive in default extlinux.conf boot entry',
	},
	{
		contents: stripIndent`
    DEFAULT primary
    TIMEOUT 30
    MENU TITLE Boot Options
    LABEL primary
          MENU LABEL primary Image
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4=woops
    `,
		reason: 'Unable to parse invalid value: isolcpus=0,4=woops',
	},
];

const SUPPORTED_VERSION = '2.45.0'; // or less
const UNSUPPORTED_VERSION = '2.47.0'; // or greater

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
		supported: false,
	},
	{
		deviceType: 'intel-nuc',
		metaRelease: UNSUPPORTED_VERSION,
		supported: false,
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
