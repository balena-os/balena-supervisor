import { expect } from 'chai';
import { ExtraUEnv } from '~/src/config/backends/extra-uEnv';

describe('config/extra-uEnv', () => {
	const backend = new ExtraUEnv();
	it('only allows supported configuration options', () => {
		for (const { configName, supported } of [
			{ configName: 'fdt', supported: true },
			{ configName: 'isolcpus', supported: true },
			{ configName: 'custom_fdt_file', supported: false },
			{ configName: 'splash', supported: false },
			{ configName: '', supported: false },
		]) {
			expect(backend.isSupportedConfig(configName)).to.equal(supported);
		}
	});

	it('correctly detects boot config variables', () => {
		for (const { config, valid } of [
			{ config: 'HOST_EXTLINUX_isolcpus', valid: true },
			{ config: 'HOST_EXTLINUX_fdt', valid: true },
			{ config: 'HOST_EXTLINUX_rootwait', valid: true },
			{ config: 'HOST_EXTLINUX_5', valid: true },
			{ config: 'DEVICE_EXTLINUX_isolcpus', valid: false },
			{ config: 'isolcpus', valid: false },
		]) {
			expect(backend.isBootConfigVar(config)).to.equal(valid);
		}
	});

	it('converts variable to backend formatted name', () => {
		for (const { input, output } of [
			{ input: 'HOST_EXTLINUX_isolcpus', output: 'isolcpus' },
			{ input: 'HOST_EXTLINUX_fdt', output: 'fdt' },
			{ input: 'HOST_EXTLINUX_', output: null },
			{ input: 'value', output: null },
		]) {
			expect(backend.processConfigVarName(input)).to.equal(output);
		}
	});

	it('normalizes variable value', () => {
		for (const { input, output } of [
			{ input: { key: 'key', value: 'value' }, output: 'value' },
		]) {
			expect(backend.processConfigVarValue(input.key, input.value)).to.equal(
				output,
			);
		}
	});

	it('returns the environment name for config variable', () => {
		for (const { input, output } of [
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: null },
		]) {
			expect(backend.createConfigVarName(input)).to.equal(output);
		}
	});

	it('only allows supported configuration options', () => {
		for (const { configName, supported } of [
			{ configName: 'fdt', supported: true },
			{ configName: 'isolcpus', supported: true },
			{ configName: 'custom_fdt_file', supported: false },
			{ configName: 'splash', supported: false },
			{ configName: '', supported: false },
		]) {
			expect(backend.isSupportedConfig(configName)).to.equal(supported);
		}
	});

	it('correctly detects boot config variables', () => {
		for (const { config, valid } of [
			{ config: 'HOST_EXTLINUX_isolcpus', valid: true },
			{ config: 'HOST_EXTLINUX_fdt', valid: true },
			{ config: 'HOST_EXTLINUX_rootwait', valid: true },
			{ config: 'HOST_EXTLINUX_5', valid: true },
			{ config: 'DEVICE_EXTLINUX_isolcpus', valid: false },
			{ config: 'isolcpus', valid: false },
		]) {
			expect(backend.isBootConfigVar(config)).to.equal(valid);
		}
	});

	it('converts variable to backend formatted name', () => {
		for (const { input, output } of [
			{ input: 'HOST_EXTLINUX_isolcpus', output: 'isolcpus' },
			{ input: 'HOST_EXTLINUX_fdt', output: 'fdt' },
			{ input: 'HOST_EXTLINUX_', output: null },
			{ input: 'value', output: null },
		]) {
			expect(backend.processConfigVarName(input)).to.equal(output);
		}
	});

	it('normalizes variable value', () => {
		for (const { input, output } of [
			{ input: { key: 'key', value: 'value' }, output: 'value' },
		]) {
			expect(backend.processConfigVarValue(input.key, input.value)).to.equal(
				output,
			);
		}
	});

	it('returns the environment name for config variable', () => {
		for (const { input, output } of [
			{ input: 'isolcpus', output: 'HOST_EXTLINUX_isolcpus' },
			{ input: 'fdt', output: 'HOST_EXTLINUX_fdt' },
			{ input: 'rootwait', output: 'HOST_EXTLINUX_rootwait' },
			{ input: '', output: null },
		]) {
			expect(backend.createConfigVarName(input)).to.equal(output);
		}
	});
});
