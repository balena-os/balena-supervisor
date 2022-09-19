import { SinonStub, stub } from 'sinon';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { expect } from 'chai';

import Log from '~/lib/supervisor-console';
import { Odmdata } from '~/src/config/backends/odmdata';

describe('ODMDATA Configuration', () => {
	const backend = new Odmdata();
	let logWarningStub: SinonStub;
	let logErrorStub: SinonStub;
	// @ts-ignore accessing private vluae
	const previousConfigPath = Odmdata.bootConfigPath;
	const testConfigPath = resolve(process.cwd(), 'test/data/boot0.img');

	before(() => {
		// @ts-ignore setting value of private variable
		Odmdata.bootConfigPath = testConfigPath;
	});

	after(() => {
		// @ts-ignore setting value of private variable
		Odmdata.bootConfigPath = previousConfigPath;
	});

	beforeEach(() => {
		logWarningStub = stub(Log, 'warn');
		logErrorStub = stub(Log, 'error');
	});

	afterEach(() => {
		logWarningStub.restore();
		logErrorStub.restore();
	});

	it('only matches supported devices', async () => {
		for (const { deviceType, match } of MATCH_TESTS) {
			await expect(backend.matches(deviceType)).to.eventually.equal(match);
		}
	});

	it('logs error when unable to open boot config file', async () => {
		const logs = [
			{
				error: { code: 'ENOENT' },
				message: `File not found at: ${testConfigPath}`,
			},
			{
				error: { code: 'EACCES' },
				message: `Permission denied when opening '${testConfigPath}'`,
			},
			{
				error: { code: 'UNKNOWN ISSUE' }, // not a real code
				message: `Unknown error when opening '${testConfigPath}'`,
			},
		];
		const openFileStub = stub(fs, 'open');
		for (const log of logs) {
			// Stub openFileStub with specific error
			openFileStub.rejects(log.error);
			try {
				// @ts-ignore accessing private value
				await backend.getFileHandle(testConfigPath);
			} catch {
				// noop
			}
			// Check that correct message was logged
			expect(logErrorStub.lastCall?.args[0]).to.equal(log.message);
		}
		openFileStub.restore();
	});

	it('should parse configuration options from bootConfigPath', async () => {
		// Restore openFile so test actually uses testConfigPath
		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			configuration: '2',
		});
	});

	it('correctly parses configuration mode', async () => {
		for (const config of CONFIG_MODES) {
			// @ts-ignore accessing private value
			expect(backend.parseOptions(config.buffer)).to.deep.equal({
				configuration: config.mode,
			});
		}
	});

	it('logs error for malformed configuration mode', async () => {
		// Logs when configuration mode is unknown
		try {
			// @ts-ignore accessing private value
			backend.parseOptions(Buffer.from([0x9, 0x9, 0x9]));
		} catch (e) {
			// noop
		}
		// Check that correct message was logged
		expect(logErrorStub.lastCall?.lastArg).to.equal(
			'ODMDATA is set with an unsupported byte: 0x9',
		);

		// Logs when bytes don't match
		try {
			// @ts-ignore accessing private value
			backend.parseOptions(Buffer.from([0x1, 0x0, 0x0]));
		} catch {
			// noop
		}
		// Check that correct message was logged
		expect(logErrorStub.lastCall?.lastArg).to.equal(
			'Unable to parse ODMDATA configuration. Data at offsets do not match.',
		);
	});

	it('unlock/lock bootConfigPath RO access', async () => {
		const writeSpy = stub().resolves();
		// @ts-ignore accessing private value
		const handleStub = stub(backend, 'getFileHandle').resolves({
			write: writeSpy,
			close: async (): Promise<void> => {
				// noop
			},
		});

		// @ts-ignore accessing private value
		await backend.setReadOnly(false); // Try to unlock
		expect(writeSpy).to.be.calledWith('0');

		// @ts-ignore accessing private value
		await backend.setReadOnly(true); // Try to lock
		expect(writeSpy).to.be.calledWith('1');

		handleStub.restore();
	});

	it('sets new config values', async () => {
		// @ts-ignore accessing private value
		const setROStub = stub(backend, 'setReadOnly');
		setROStub.resolves();
		// Get current config
		const originalConfig = await backend.getBootConfig();
		try {
			// Sets a new configuration
			await backend.setBootConfig({
				configuration: '4',
			});
			// Check that new configuration was set correctly
			await expect(backend.getBootConfig()).to.eventually.deep.equal({
				configuration: '4',
			});
		} finally {
			// Restore previous value
			await backend.setBootConfig(originalConfig);
			setROStub.restore();
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
