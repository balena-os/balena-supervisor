import { promises as fs } from 'fs';
import { stripIndent } from 'common-tags';
import { expect } from 'chai';
import { testfs } from 'mocha-pod';

import * as hostUtils from '~/lib/host-utils';
import { Extlinux } from '~/src/config/backends/extlinux';

describe('config/extlinux', () => {
	it('should correctly parse an extlinux.conf file', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extlinux/extlinux.conf')]: stripIndent`
	    	DEFAULT primary
				# CommentExtlinux files

				TIMEOUT 30
				MENU TITLE Boot Options
				LABEL primary
							MENU LABEL primary Image
							LINUX /Image
							FDT /boot/mycustomdtb.dtb
							APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=3\
			`,
		}).enable();
		const extLinux = new Extlinux();

		await expect(extLinux.getBootConfig()).to.eventually.deep.equal({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '3',
		});

		await tfs.restore();
	});

	it('should parse multiple service entries', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extlinux/extlinux.conf')]: stripIndent`
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
			`,
		}).enable();
		const extLinux = new Extlinux();

		await expect(extLinux.getBootConfig()).to.eventually.deep.equal({
			fdt: '/boot/mycustomdtb.dtb',
		});

		await tfs.restore();
	});

	it('only matches supported devices', async () => {
		const extLinux = new Extlinux();
		for (const { deviceType, metaRelease, supported } of MATCH_TESTS) {
			await expect(
				extLinux.matches(deviceType, metaRelease),
			).to.eventually.equal(supported);
		}
	});

	it('errors when cannot find extlinux.conf', async () => {
		// The file does not exist before the test
		await expect(fs.access(hostUtils.pathOnBoot('extlinux/extlinux.conf'))).to
			.be.rejected;
		const extLinux = new Extlinux();
		// Stub readFile to reject much like if the file didn't exist
		await expect(extLinux.getBootConfig()).to.eventually.be.rejectedWith(
			'Could not find extlinux file. Device is possibly bricked',
		);
	});

	it('throws error for malformed extlinux.conf', async () => {
		for (const badConfig of MALFORMED_CONFIGS) {
			const tfs = await testfs({
				[hostUtils.pathOnBoot('extlinux/extlinux.conf')]: badConfig,
			}).enable();
			const extLinux = new Extlinux();

			// Expect correct rejection from the given bad config
			await expect(extLinux.getBootConfig()).to.be.rejectedWith(
				badConfig.reason,
			);

			await tfs.restore();
		}
	});

	it('sets new config values', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extlinux/extlinux.conf')]: stripIndent`
	    	DEFAULT primary
				TIMEOUT 30
				MENU TITLE Boot Options
				LABEL primary
      				MENU LABEL primary Image
      				LINUX /Image
      				APPEND \${cbootargs} \${resin_kernel_root} ro rootwait\
			`,
		}).enable();

		const extLinux = new Extlinux();
		await extLinux.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2',
		});

		await expect(
			fs.readFile(hostUtils.pathOnBoot('extlinux/extlinux.conf'), 'utf8'),
		).to.eventually.equal(
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

		await tfs.restore();
	});

	it('only allows supported configuration options', () => {
		const extLinux = new Extlinux();
		[
			{ configName: 'isolcpus', supported: true },
			{ configName: 'fdt', supported: true },
			{ configName: '', supported: false },
			{ configName: 'ro', supported: false }, // not allowed to configure
			{ configName: 'rootwait', supported: false }, // not allowed to configure
		].forEach(({ configName, supported }) =>
			expect(extLinux.isSupportedConfig(configName)).to.equal(supported),
		);
	});

	it('correctly detects boot config variables', () => {
		const extLinux = new Extlinux();
		[
			{ config: 'HOST_EXTLINUX_isolcpus', valid: true },
			{ config: 'HOST_EXTLINUX_fdt', valid: true },
			{ config: 'HOST_EXTLINUX_rootwait', valid: true },
			{ config: 'HOST_EXTLINUX_5', valid: true },
			// TODO: { config: 'HOST_EXTLINUX', valid: false },
			// TODO: { config: 'HOST_EXTLINUX_', valid: false },
			{ config: 'DEVICE_EXTLINUX_isolcpus', valid: false },
			{ config: 'isolcpus', valid: false },
		].forEach(({ config, valid }) =>
			expect(extLinux.isBootConfigVar(config)).to.equal(valid),
		);
	});

	it('converts variable to backend formatted name', () => {
		const extLinux = new Extlinux();
		[
			{ input: 'HOST_EXTLINUX_isolcpus', output: 'isolcpus' },
			{ input: 'HOST_EXTLINUX_fdt', output: 'fdt' },
			{ input: 'HOST_EXTLINUX_rootwait', output: 'rootwait' },
			{ input: 'HOST_EXTLINUX_something_else', output: 'something_else' },
			{ input: 'HOST_EXTLINUX_', output: 'HOST_EXTLINUX_' },
			{ input: 'HOST_EXTLINUX_ ', output: ' ' },
			{ input: 'ROOT_EXTLINUX_isolcpus', output: 'ROOT_EXTLINUX_isolcpus' },
		].forEach(({ input, output }) =>
			expect(extLinux.processConfigVarName(input)).to.equal(output),
		);
	});

	it('normalizes variable value', () => {
		const extLinux = new Extlinux();
		[{ input: { key: 'key', value: 'value' }, output: 'value' }].forEach(
			({ input, output }) =>
				expect(extLinux.processConfigVarValue(input.key, input.value)).to.equal(
					output,
				),
		);
	});

	it('returns the environment name for config variable', () => {
		const extLinux = new Extlinux();
		[
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: 'HOST_EXTLINUX_' },
			{ input: '5', output: 'HOST_EXTLINUX_5' },
		].forEach(({ input, output }) =>
			expect(extLinux.createConfigVarName(input)).to.equal(output),
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
