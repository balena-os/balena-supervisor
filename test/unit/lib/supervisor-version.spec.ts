import { expect } from 'chai';
import { version as packageJsonVersion } from '~/src/../package.json';
import { supervisorVersion } from '~/lib/supervisor-version';

describe('lib/supervisor-version', () => {
	it('should return the version from package.json', () => {
		expect(supervisorVersion).to.equal(packageJsonVersion);
	});
});
