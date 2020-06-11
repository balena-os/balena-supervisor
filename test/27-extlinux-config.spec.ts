import { child_process, fs } from 'mz';
import { stripIndent } from 'common-tags';
import { SinonStub, stub } from 'sinon';

import { expect } from './lib/chai-config';
import * as fsUtils from '../src/lib/fs-utils';
import { ExtlinuxConfigBackend } from '../src/config/backends/extlinux';

describe('EXTLINUX Configuration', () => {
	const backend = new ExtlinuxConfigBackend();

	it('only matches supported devices', () => {
		[
			{ deviceType: 'jetson-tx', supported: true },
			{ deviceType: 'raspberry', supported: false },
			{ deviceType: 'fincm3', supported: false },
			{ deviceType: 'up-board', supported: false },
		].forEach(({ deviceType, supported }) =>
			expect(backend.matches(deviceType)).to.equal(supported),
		);
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
			await expect(backend.getBootConfig()).to.eventually.be.rejectedWith(
				badConfig.reason,
			);
			// Restore stub
			(fs.readFile as SinonStub).restore();
		}
	});

	it('parses supported config values from bootConfigPath', async () => {
		// Will try to parse /test/data/mnt/boot/extlinux/extlinux.conf
		await expect(backend.getBootConfig()).to.eventually.deep.equal({}); // None of the values are supported so returns empty

		// Stub readFile to return a config that has supported values
		stub(fs, 'readFile').resolves(stripIndent`
    DEFAULT primary\n
    TIMEOUT 30\n
    MENU TITLE Boot Options\n
    LABEL primary\n
          MENU LABEL primary Image\n
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4
    `);

		await expect(backend.getBootConfig()).to.eventually.deep.equal({
			isolcpus: '0,4',
		});

		// Restore stub
		(fs.readFile as SinonStub).restore();
	});

	it('sets new config values', async () => {
		stub(fsUtils, 'writeFileAtomic').resolves();
		stub(child_process, 'exec').resolves();

		await backend.setBootConfig({
			isolcpus: '2',
			randomValueBut: 'that_is_ok', // The backend just sets what it is told. validation is ended in device-config.ts
		});

		expect(fsUtils.writeFileAtomic).to.be.calledWith(
			'./test/data/mnt/boot/extlinux/extlinux.conf',
			stripIndent`\
	      DEFAULT primary\n\
	      TIMEOUT 30\n\
	      MENU TITLE Boot Options\n\
	      LABEL primary\n\
	      MENU LABEL primary Image\n\
	      LINUX /Image\n\
	      APPEND \${cbootargs} \${resin_kernel_root} ro rootwait isolcpus=2 randomValueBut=that_is_ok\n\
	    ` + '\n', // add newline because stripIndent trims last newline
		);

		// Restore stubs
		(fsUtils.writeFileAtomic as SinonStub).restore();
		(child_process.exec as SinonStub).restore();
	});

	it('only allows supported configuration options', () => {
		[
			{ configName: 'isolcpus', supported: true },
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
    TIMEOUT 30\n
    MENU TITLE Boot Options\n
    LABEL primary\n
          MENU LABEL primary Image\n
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4
    `,
		reason: 'Could not find default entry for extlinux.conf file',
	},
	{
		contents: stripIndent`
    DEFAULT typo_oops\n
    TIMEOUT 30\n
    MENU TITLE Boot Options\n
    LABEL primary\n
          MENU LABEL primary Image\n
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4
    `,
		reason:
			'Cannot find default label entry (label: typo_oops) for extlinux.conf file',
	},
	{
		contents: stripIndent`
    DEFAULT primary\n
    TIMEOUT 30\n
    MENU TITLE Boot Options\n
    LABEL primary\n
          MENU LABEL primary Image\n
          LINUX /Image
    `,
		reason:
			'Could not find APPEND directive in default extlinux.conf boot entry',
	},
	{
		contents: stripIndent`
    DEFAULT primary\n
    TIMEOUT 30\n
    MENU TITLE Boot Options\n
    LABEL primary\n
          MENU LABEL primary Image\n
          LINUX /Image
          APPEND ro rootwait isolcpus=0,4=woops
    `,
		reason:
			'Could not parse extlinux configuration entry: ro,rootwait,isolcpus=0,4=woops [value with error: isolcpus=0,4=woops]',
	},
];
