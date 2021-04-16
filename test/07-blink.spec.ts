import { promises as fs } from 'fs';
import { expect } from 'chai';

import blink = require('../src/lib/blink');
import constants = require('../src/lib/constants');

describe('blink', () => {
	it('is a blink function', () => expect(blink).to.be.a('function'));

	it('has a pattern property with start and stop functions', () => {
		expect(blink.pattern.start).to.be.a('function');
		expect(blink.pattern.stop).to.be.a('function');
	});

	it.skip('writes to a file that represents the LED, and writes a 0 at the end to turn the LED off', async () => {
		// TODO: This test is skipped because of typings for blink module. Fix typings with a .d.ts file for the blinking module.
		await (blink as any)(1);
		const contents = await fs.readFile(constants.ledFile);

		expect(contents.toString()).to.equal('0');
	});
});
