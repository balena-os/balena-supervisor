import ChaiConfig = require('./lib/chai-config');
import prepare = require('./lib/prepare');

const { expect } = ChaiConfig;

import constants = require('../src/lib/constants');

describe('constants', function () {
	before(() => prepare());
	it('has the correct configJsonPathOnHost', () =>
		expect(constants.configJsonPathOnHost).to.equal('/config.json'));
	it('has the correct rootMountPoint', () =>
		expect(constants.rootMountPoint).to.equal('./test/data'));
});
