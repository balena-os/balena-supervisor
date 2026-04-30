import { expect } from 'chai';

import { ConfigTxt } from '~/src/config/backends/config-txt';

describe('config/config-txt', () => {
	const backend = new ConfigTxt();

	describe('processConfigVarValue', () => {
		it('parses a quoted CSV array value into multiple entries', () => {
			expect(
				backend.processConfigVarValue(
					'dtparam',
					'"i2c_arm=on","spi=on","audio=off"',
				),
			).to.deep.equal(['i2c_arm=on', 'spi=on', 'audio=off']);
		});

		it('returns an unquoted single value as a one-element array', () => {
			expect(
				backend.processConfigVarValue('dtparam', 'i2c_arm=on'),
			).to.deep.equal(['i2c_arm=on']);
		});

		it('tolerates leading/trailing whitespace around a quoted CSV array', () => {
			expect(
				backend.processConfigVarValue(
					'dtparam',
					' "i2c_arm=on","spi=on","audio=off"',
				),
			).to.deep.equal(['i2c_arm=on', 'spi=on', 'audio=off']);

			expect(
				backend.processConfigVarValue(
					'dtparam',
					'"i2c_arm=on","spi=on","audio=off"  ',
				),
			).to.deep.equal(['i2c_arm=on', 'spi=on', 'audio=off']);
		});

		it('returns non-array config values unchanged', () => {
			expect(backend.processConfigVarValue('disable_splash', '1')).to.equal(
				'1',
			);
		});
	});
});
