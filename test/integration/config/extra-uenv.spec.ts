import { stripIndent } from 'common-tags';
import { expect } from 'chai';
import { testfs } from 'mocha-pod';
import { promises as fs } from 'fs';

import * as hostUtils from '~/lib/host-utils';
import log from '~/lib/supervisor-console';
import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';

describe('config/extra_uEnv', () => {
	const backend = new ExtraUEnv();

	it('should parse all configuration options from bootConfigPath', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]:
				'custom_fdt_file=/path/to/mycustom.dtb\n' +
				'\t\textra_os_cmdline=isolcpus=3,4 console=tty0 splash\n',
		}).enable();

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			fdt: '/path/to/mycustom.dtb',
			// extra_os_cmdline should be sorted alphabetically
			extra_os_cmdline: 'console=tty0 isolcpus=3,4 splash',
		});

		await tfs.restore();
	});

	it('should ignore configs with unsupported values from bootConfigPath', async () => {
		// Configuration with no supported values
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	fdt=something_else
			 	isolcpus=3,4
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

	it('sets new config values with legacy isolcpus which erases other values in extra_os_cmdline', async () => {
		const tfs = await testfs({
			// This config contains a value set from something else
			// We to make sure the Supervisor is enforcing the source of truth (the cloud)
			// So after setting new values, unsupported lines should be gone
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait isolcpus=3,4
	     other_service=remove_this_value
			`,
		}).enable();

		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2,4',
		});

		// Confirm that the file was written correctly
		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=isolcpus=2,4\n',
		);

		await tfs.restore();
	});

	it('sets new config values with extra_os_cmdline', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait isolcpus=3,4
	     other_service=remove_this_value
			`,
		}).enable();

		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			extra_os_cmdline: 'console=tty0 rootwait isolcpus=1,2',
		});

		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=console=tty0 isolcpus=1,2 rootwait\n',
		);

		await tfs.restore();
	});

	it('sets new config values with extra_os_cmdline while overwriting current legacy isolcpus', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=isolcpus=3,4
	     other_service=remove_this_value
			`,
		}).enable();

		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			// No isolcpus value in target state
			extra_os_cmdline: 'splash console=tty0 rootwait',
		});

		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=console=tty0 rootwait splash\n',
		);

		await tfs.restore();
	});

	it('sets new config values with extra_os_cmdline taking precedence over legacy isolcpus if values differ', async () => {
		const tfs = await testfs({
			[hostUtils.pathOnBoot('extra_uEnv.txt')]: stripIndent`
	    	extra_os_cmdline=rootwait isolcpus=3,4
	     other_service=remove_this_value
			`,
		}).enable();

		await backend.setBootConfig({
			fdt: '/boot/mycustomdtb.dtb',
			isolcpus: '2,4',
			extra_os_cmdline: 'splash console=tty0 rootwait isolcpus=1,2',
		});

		await expect(
			fs.readFile(hostUtils.pathOnBoot('extra_uEnv.txt'), 'utf8'),
		).to.eventually.equal(
			'custom_fdt_file=/boot/mycustomdtb.dtb\nextra_os_cmdline=console=tty0 isolcpus=1,2 rootwait splash\n',
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
		reason: 'Unsupported or malformed extra_uEnv entry: another_value',
	},
	{
		contents: stripIndent`
      custom_fdt_file=mycustom.dtb
      extra_os_cmdline=isolcpus=3,4
      foo=bar
    `,
		reason: 'Unsupported or malformed extra_uEnv entry: foo=bar',
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
