// This was originally wrapped in a do block in
// coffeescript, and it's not clear now why that was the
// case, so I'm going to maintain that behaviour
(() => {
	// Make NodeJS RFC 3484 compliant for properly handling IPv6
	// See: https://github.com/nodejs/node/pull/14731
	//      https://github.com/nodejs/node/pull/17793
	const dns = require('dns');
	const { lookup } = dns;
	dns.lookup = (name: string, opts: any, cb: (err?: Error) => void) => {
		if (typeof cb !== 'function') {
			return lookup(name, { verbatim: true }, opts);
		}
		return lookup(name, Object.assign({ verbatim: true }, opts), cb);
	};
})();

import Supervisor from './supervisor';

const supervisor = new Supervisor();
supervisor.init();
