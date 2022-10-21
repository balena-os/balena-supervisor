import { expect } from 'chai';

import { Odmdata } from '~/src/config/backends/odmdata';

describe('config/odmdata', () => {
	const backend = new Odmdata();

	it('only matches supported devices', async () => {
		for (const { deviceType, match } of MATCH_TESTS) {
			await expect(backend.matches(deviceType)).to.eventually.equal(match);
		}
	});

	it('correctly parses configuration mode', async () => {
		for (const config of CONFIG_MODES) {
			// @ts-expect-error accessing private value
			expect(backend.parseOptions(config.buffer)).to.deep.equal({
				configuration: config.mode,
			});
		}
	});

	it('only allows supported configuration modes', () => {
		[
			{ configName: 'configuration', supported: true },
			{ configName: 'mode', supported: false },
			{ configName: '', supported: false },
		].forEach(({ configName, supported }) =>
			expect(backend.isSupportedConfig(configName)).to.equal(supported),
		);
	});

	it('correctly detects boot config variables', () => {
		[
			{ config: 'HOST_ODMDATA_configuration', valid: true },
			{ config: 'ODMDATA_configuration', valid: false },
			{ config: 'HOST_CONFIG_odmdata_configuration', valid: false },
			{ config: 'HOST_EXTLINUX_rootwait', valid: false },
			{ config: '', valid: false },
		].forEach(({ config, valid }) =>
			expect(backend.isBootConfigVar(config)).to.equal(valid),
		);
	});

	it('converts variable to backend formatted name', () => {
		[
			{ input: 'HOST_ODMDATA_configuration', output: 'configuration' },
			{ input: 'HOST_ODMDATA_', output: null },
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
			{ input: 'configuration', output: 'HOST_ODMDATA_configuration' },
			{ input: '', output: null },
		].forEach(({ input, output }) =>
			expect(backend.createConfigVarName(input)).to.equal(output),
		);
	});
});

const CONFIG_MODES = [
	{
		mode: '1',
		buffer: Buffer.from([0x0, 0x0, 0x0]),
	},
	{
		mode: '2',
		buffer: Buffer.from([0x1, 0x1, 0x1]),
	},
	{
		mode: '3',
		buffer: Buffer.from([0x6, 0x6, 0x6]),
	},
	{
		mode: '4',
		buffer: Buffer.from([0x7, 0x7, 0x7]),
	},
	{
		mode: '5',
		buffer: Buffer.from([0x2, 0x2, 0x2]),
	},
	{
		mode: '6',
		buffer: Buffer.from([0x3, 0x3, 0x3]),
	},
];

const MATCH_TESTS = [
	{
		deviceType: 'blackboard-tx2',
		match: true,
	},
	{
		deviceType: 'jetson-tx2',
		match: true,
	},
	{
		deviceType: 'n510-tx2',
		match: true,
	},
	{
		deviceType: 'orbitty-tx2',
		match: true,
	},
	{
		deviceType: 'spacely-tx2',
		match: true,
	},
	{
		deviceType: 'srd3-tx2',
		match: true,
	},
	{
		deviceType: 'raspberry-pi',
		match: false,
	},
	{
		deviceType: 'up-board',
		match: false,
	},
	{
		deviceType: '',
		match: false,
	},
];
