import { expect } from 'chai';
import { promisify } from 'util';

import '~/src/mdns';

describe('MDNS', () => {
	it('resolves global domain names', async () => {
		const dns = require('dns'); // eslint-disable-line
		const lookup = promisify(dns.lookup);
		const res = await lookup('www.google.com', { all: true });
		expect(res).to.not.be.null;
		expect(res.length).to.be.greaterThan(0);
		expect(Object.keys(res[0])).to.deep.equal(['address', 'family']);
	});

	it('resolves .local domain names', async () => {
		const dns = require('dns'); // eslint-disable-line
		const lookup = promisify(dns.lookup);
		const res = await lookup('my-device.local', { all: true });
		expect(res).to.not.be.null;
		expect(res.length).to.be.greaterThan(0);
		expect(Object.keys(res[0])).to.deep.equal(['address', 'family']);
	});
});
