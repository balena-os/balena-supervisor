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

	it('matches all devices', async () => {
		// The file exists before
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	custom_fdt_file=mycustom.dtb
      	extra_os_cmdline=isolcpus=3,4
			`,
		}).enable();
		// Test device that has extra_uEnv.txt
		await Promise.all(
			MATCH_TESTS.map(async () => {
				await expect(backend.matches()).to.eventually.be.true;
			}),
		);

		await tfs.restore();

		// The file doesn't exist before
		await expect(
			fs.access(hostUtils.pathOnBoot('extra_uEnv.txt')),
			'extra_uEnv.txt does not exist before the test',
		).to.be.rejected;
		// Test same device but without extra_uEnv.txt
		await Promise.all(
			MATCH_TESTS.map(async () => {
				await expect(backend.matches()).to.eventually.be.true;
			}),
		);
	});

	it('creates extra_uEnv.txt if it does not exist', async () => {
		// FIXME: If test-fs is initiated while a file doesn't exist but
		// the file is created during tests, it will be created in the real fs
		// and won't be cleaned up with testfs.restore().
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: 'foo',
		}).enable();
		await fs.unlink(hostUtils.pathOnBoot('extra_uEnv.txt'));

		await expect(
			fs.access(hostUtils.pathOnBoot('extra_uEnv.txt')),
			'extra_uEnv.txt does not exist before the test',
		).to.be.rejected;

		// This should create the file
		await expect(backend.getBootConfig()).to.eventually.deep.equal({});

		await expect(
			fs.access(hostUtils.pathOnBoot('extra_uEnv.txt')),
			'extra_uEnv.txt should have been created',
		).to.be.fulfilled;

		await tfs.restore();

		// No file leftover after testfs cleanup
		await expect(fs.access(hostUtils.pathOnBoot('extra_uEnv.txt'))).to.be
			.rejected;
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
			// This config contains a value set from something else
			// We to make sure the Supervisor is enforcing the source of truth (the cloud)
			// So after setting new values this unsupported/not set value should be gone
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait isolcpus=3,4
	     other_service=set_this_value
			`,
		}).enable();

		// Sets config with mix of supported and not supported values
		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2',
			console: 'tty0', // not supported so won't be set
		});

		// Confirm that the file was written correctly
		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2\n',
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

		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2 console=tty0 splash\n',
		);

		// @ts-expect-error accessing private value
		ExtraUEnv.supportedConfigs = previousSupportedConfigs;

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
	{ type: 'intel-nuc', supported: true },
	{ type: 'raspberry', supported: true },
	{ type: 'fincm3', supported: true },
	{ type: 'asus-tinker-board', supported: true },
	{ type: 'nano-board', supported: true },
	{ type: 'jetson-nano-2gb-devkit', supported: true },
	{ type: 'jetson-nano-2gb-devkit-emmc', supported: true },
	{ type: 'tx2-tx2-device', supported: true },
	{ type: 'jetson-tx2-nx-devkit', supported: true },
	{ type: 'photon-tx2-nx', supported: true },
	{ type: 'jetson-xavier-nx-devkit', supported: true },
	{ type: 'jetson-agx-orin-devkit', supported: true },
	{ type: 'jetson-agx-orin', supported: true },
	{ type: 'jetson-orin-nx-xavier-nx-devkit', supported: true },
	{ type: 'cti-orin-nx-custom-carrier', supported: true },
	{ type: 'jetson-orin-agx-nx-xavier-nx-devkit', supported: true },
	{ type: 'jetson-orin-nano-devkit-nvme', supported: true },
	{ type: 'jetson-orin-agx-nano-devkit-nvme', supported: true },
	{ type: 'photon-xavier-nx', supported: true },
	{ type: 'imx8m-var-dart', supported: true },
	{ type: 'imx8mm-var-dart', supported: true },
	{ type: 'imx8mm-var-dart-nrt', supported: true },
	{ type: 'imx8mm-var-dart-plt', supported: true },
	{ type: 'imx8mm-var-som', supported: true },
	{ type: 'imx8m-var-som', supported: true },
	{ type: 'imx6ul-var-dart', supported: true },
];
