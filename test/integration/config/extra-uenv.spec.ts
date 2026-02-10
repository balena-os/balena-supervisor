import { stripIndent } from 'common-tags';
import { expect } from 'chai';
import { testfs } from 'mocha-pod';
import { promises as fs } from 'fs';

import * as hostUtils from '~/lib/host-utils';
import log from '~/lib/supervisor-console';
import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';

describe('config/extra-uEnv', () => {
	const backend = new ExtraUEnv();

	it('should parse extra_uEnv string', () => {
		const fileContents = stripIndent`\
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4 splash console=tty0
		`;
		// @ts-expect-error accessing private method
		const parsed = ExtraUEnv.parseOptions(fileContents);
		expect(parsed).to.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
			splash: '',
			console: 'tty0',
		});
	});

	it('should only parse supported configuration options from bootConfigPath', async () => {
		let tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	custom_fdt_file=mycustom.dtb
      	extra_os_cmdline=isolcpus=3,4
			`,
		}).enable();

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
		});

		await tfs.restore();

		// Add other options that will get filtered out because they aren't supported
		tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	custom_fdt_file=mycustom.dtb
        extra_os_cmdline=isolcpus=3,4 console=tty0 splash
			`,
		}).enable();

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			fdt: 'mycustom.dtb',
			isolcpus: '3,4',
		});

		await tfs.restore();

		// Configuration with no supported values
		tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	fdt=something_else
			 	isolcpus
				123.12=5
			`,
		}).enable();
		await expect(backend.getBootConfig()).to.eventually.deep.equal({});

		await tfs.restore();
	});

	it('only matches supported devices', async () => {
		// The file exists before
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	custom_fdt_file=mycustom.dtb
      	extra_os_cmdline=isolcpus=3,4
			`,
		}).enable();
		for (const device of MATCH_TESTS) {
			// Test device that has extra_uEnv.txt
			await expect(backend.matches(device.type)).to.eventually.equal(
				device.supported,
			);
		}

		await tfs.restore();

		// The file no longer exists
		await expect(
			fs.access(hostUtils.pathOnBoot('extra_uEnv.txt')),
			'extra_uEnv.txt does not exist before the test',
		).to.be.rejected;
		for (const device of MATCH_TESTS) {
			// Test same device but without extra_uEnv.txt
			await expect(backend.matches(device.type)).to.eventually.be.false;
		}
	});

	it('errors when cannot find extra_uEnv.txt', async () => {
		// The file no longer exists
		await expect(
			fs.access(hostUtils.pathOnBoot('extra_uEnv.txt')),
			'extra_uEnv.txt does not exist before the test',
		).to.be.rejected;
		await expect(backend.getBootConfig()).to.eventually.be.rejectedWith(
			'Could not find extra_uEnv file. Device is possibly bricked',
		);
	});

	it('logs warning for malformed extra_uEnv.txt', async () => {
		for (const badConfig of MALFORMED_CONFIGS) {
			// Setup the environment with a bad config
			const tfs = await testfs({
				[hostUtils.pathOnBoot('extra_uEnv.txt')]: badConfig.contents,
			}).enable();

			// Expect warning log from the given bad config
			await backend.getBootConfig();

			expect(log.warn).to.have.been.calledWith(badConfig.reason);
			await tfs.restore();
		}
	});

	it('sets new config values', async () => {
		const tfs = await testfs({
			// This config contains values set from something else
			// Managed values should be updated, but unmanaged entries should be preserved
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait isolcpus=3,4
	     extra_os_firmware_class_path=/var/lib/docker/volumes/extra-firmware/_data
			`,
		}).enable();

		// Sets config with mix of supported and not supported values
		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2',
			console: 'tty0', // not supported so won't be set
		});

		// Confirm that the file was written correctly
		// - extra_os_cmdline should contain only the new isolcpus value with unmanaged values removed
		// - extra_os_firmware_class_path (unrecognized top-level entry) should be preserved
		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'extra_os_cmdline=isolcpus=2\nextra_os_firmware_class_path=/var/lib/docker/volumes/extra-firmware/_data\ncustom_fdt_file=/boot/mycustomdtb.dtb\n',
		);

		expect(log.warn).to.have.been.calledWith(
			'Not setting unsupported value: { console: tty0 }',
		);

		await tfs.restore();
	});

	it('sets new config values containing collections', async () => {
		// @ts-expect-error accessing private value
		const previousSupportedConfigs = ExtraUEnv.supportedConfigs;
		// Stub isSupportedConfig so we can confirm collections work
		// @ts-expect-error accessing private value
		ExtraUEnv.supportedConfigs = {
			fdt: { key: 'custom_fdt_file', collection: false },
			isolcpus: { key: 'extra_os_cmdline', collection: true },
			console: { key: 'extra_os_cmdline', collection: true },
			splash: { key: 'extra_os_cmdline', collection: true },
		};

		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	     	other_service=set_this_value
			`,
		}).enable();

		// Set config again
		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2', // collection entry so should be concatted to other collections of this entry
			console: 'tty0', // collection entry so should be concatted to other collections of this entry
			splash: '', // collection entry so should be concatted to other collections of this entry
		});

		// other_service (unrecognized top-level entry) should be preserved
		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'other_service=set_this_value\ncustom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2 console=tty0 splash\n',
		);

		// @ts-expect-error accessing private value
		ExtraUEnv.supportedConfigs = previousSupportedConfigs;

		await tfs.restore();
	});

	it('preserves extra fields when no managed items are in opts', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait splash
	     extra_os_firmware_class_path=/var/lib/docker/volumes/extra-firmware/_data
			`,
		}).enable();

		// Set config with no managed values — managed keys should be removed,
		// but unrecognized top-level entries should be preserved
		await backend.setBootConfig({});

		// only isolcpus in extra_os_cmdline is managed so extra_os_cmdline gets removed if not isolcpus
		// the unrecognized top-level entry should be preserved
		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'extra_os_firmware_class_path=/var/lib/docker/volumes/extra-firmware/_data\n',
		);

		await tfs.restore();
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
	{ type: 'jetson-agx-orin-devkit', supported: true },
	{ type: 'jetson-agx-orin', supported: false },
	{ type: 'jetson-orin-nx-xavier-nx-devkit', supported: true },
	{ type: 'cti-orin-nx-custom-carrier', supported: true },
	{ type: 'jetson-orin-agx-nx-xavier-nx-devkit', supported: false },
	{ type: 'jetson-orin-nano-devkit-nvme', supported: true },
	{ type: 'jetson-orin-agx-nano-devkit-nvme', supported: false },
	{ type: 'photon-xavier-nx', supported: false },
	{ type: 'imx8m-var-dart', supported: true },
	{ type: 'imx8mm-var-dart', supported: true },
	{ type: 'imx8mm-var-dart-nrt', supported: true },
	{ type: 'imx8mm-var-dart-plt', supported: true },
	{ type: 'imx8mm-var-som', supported: true },
	{ type: 'imx8m-var-som', supported: false },
	{ type: 'imx6ul-var-dart', supported: false },
];
