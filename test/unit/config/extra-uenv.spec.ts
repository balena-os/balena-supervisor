import { expect } from 'chai';
import { stripIndent } from 'common-tags';

import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';

describe('config/extra-uEnv', () => {
	const backend = new ExtraUEnv();
	it('only allows supported configuration options', () => {
		[
			{ configName: 'fdt', supported: true },
			{ configName: 'isolcpus', supported: true },
			{ configName: 'extra_os_cmdline', supported: true },
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
			{ config: 'HOST_EXTLINUX_extra_os_cmdline', valid: true },
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
			{ input: 'HOST_EXTLINUX_extra_os_cmdline', output: 'extra_os_cmdline' },
			{ input: 'HOST_EXTLINUX_', output: null },
			{ input: 'value', output: null },
		].forEach(({ input, output }) =>
			expect(backend.processConfigVarName(input)).to.equal(output),
		);
	});

	it('normalizes variable value', () => {
		[{ input: { key: 'key', value: 'value' }, output: 'value' }].forEach(
			({ input, output }) =>
				expect(backend.processConfigVarValue(input.key, input.value)).to.equal(
					output,
				),
		);
	});

	it('returns the environment name for config variable', () => {
		[
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'extra_os_cmdline', output: 'HOST_EXTLINUX_extra_os_cmdline' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: null },
		].forEach(({ input, output }) =>
			expect(backend.createConfigVarName(input)).to.equal(output),
		);
	});

	it('only allows supported configuration options', () => {
		[
			{ configName: 'fdt', supported: true },
			{ configName: 'isolcpus', supported: true },
			{ configName: 'extra_os_cmdline', supported: true },
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
			{ config: 'HOST_EXTLINUX_extra_os_cmdline', valid: true },
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
			{ input: 'HOST_EXTLINUX_extra_os_cmdline', output: 'extra_os_cmdline' },
			{ input: 'HOST_EXTLINUX_', output: null },
			{ input: 'value', output: null },
		].forEach(({ input, output }) =>
			expect(backend.processConfigVarName(input)).to.equal(output),
		);
	});

	it('normalizes variable value', () => {
		[{ input: { key: 'key', value: 'value' }, output: 'value' }].forEach(
			({ input, output }) =>
				expect(backend.processConfigVarValue(input.key, input.value)).to.equal(
					output,
				),
		);
	});

	it('returns the environment name for config variable', () => {
		[
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'extra_os_cmdline', output: 'HOST_EXTLINUX_extra_os_cmdline' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: null },
		].forEach(({ input, output }) =>
			expect(backend.createConfigVarName(input)).to.equal(output),
		);
	});

	it('parses extra_uEnv fdt', () => {
		const fileContents = stripIndent`\
      custom_fdt_file=/path/to/mycustom.dtb
		`;
		// @ts-expect-error accessing private method
		const parsed = ExtraUEnv.parseOptions(fileContents);
		expect(parsed).to.deep.equal({
			fdt: '/path/to/mycustom.dtb',
		});
	});

	it('parses extra_uEnv extra_os_cmdline in alphabetical order', () => {
		const fileContents = stripIndent`\
      extra_os_cmdline=isolcpus=3,4 splash console=tty0 rootwait
		`;
		// @ts-expect-error accessing private method
		const parsed = ExtraUEnv.parseOptions(fileContents);
		expect(parsed).to.deep.equal({
			extra_os_cmdline: 'console=tty0 isolcpus=3,4 rootwait splash',
		});
	});

	it('converts config options to string while sorting collections alphabetically', () => {
		const configsToSet = {
			fdt: '/path/to/mycustom.dtb',
			extra_os_cmdline: 'isolcpus=3,4 console=tty0 splash rootwait',
		};
		// @ts-expect-error accessing private method
		const configString = ExtraUEnv.configToString(configsToSet);
		expect(configString).to.equal(
			'custom_fdt_file=/path/to/mycustom.dtb\nextra_os_cmdline=console=tty0 isolcpus=3,4 rootwait splash\n',
		);
	});

	it('uses legacy isolcpus if extra_os_cmdline is not set', () => {
		const configsToSet2 = {
			isolcpus: '3,4',
			fdt: '/path/to/mycustom.dtb',
		};
		// @ts-expect-error accessing private method
		const configString2 = ExtraUEnv.configToString(configsToSet2);
		expect(configString2).to.equal(
			'custom_fdt_file=/path/to/mycustom.dtb\nextra_os_cmdline=isolcpus=3,4\n',
		);
	});

	it('ignores legacy isolcpus if extra_os_cmdline is set', () => {
		const configsToSet = {
			fdt: '/path/to/mycustom.dtb',
			isolcpus: '3,4',
			extra_os_cmdline: 'splash rootwait console=tty0',
		};
		// @ts-expect-error accessing private method
		const configString = ExtraUEnv.configToString(configsToSet);
		expect(configString).to.equal(
			'custom_fdt_file=/path/to/mycustom.dtb\nextra_os_cmdline=console=tty0 rootwait splash\n',
		);

		const configsToSet2 = {
			fdt: '/path/to/mycustom.dtb',
			isolcpus: '3,4',
			extra_os_cmdline: 'splash rootwait console=tty0 isolcpus=1,2',
		};
		// @ts-expect-error accessing private method
		const configString2 = ExtraUEnv.configToString(configsToSet2);
		expect(configString2).to.equal(
			'custom_fdt_file=/path/to/mycustom.dtb\nextra_os_cmdline=console=tty0 isolcpus=1,2 rootwait splash\n',
		);
	});

	it('considers configs equal even when isolcpus is ignored due to extra_os_cmdline presence', () => {
		const config1 = {
			fdt: '/path/to/mycustom.dtb',
			extra_os_cmdline: 'console=tty0 isolcpus=3,4 rootwait',
			isolcpus: '5,6', // Should be ignored
		};
		const config2 = {
			fdt: '/path/to/mycustom.dtb',
			extra_os_cmdline: 'isolcpus=3,4 rootwait console=tty0', // Different order but same content
		};
		expect(backend.isEqual(config1, config2)).to.be.true;
	});
});
