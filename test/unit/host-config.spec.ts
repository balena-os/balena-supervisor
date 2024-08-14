import { expect } from 'chai';
import { stripIndent } from 'common-tags';
import type { SinonStub } from 'sinon';

import * as hostConfig from '~/src/host-config';
import { RedsocksConf } from '~/src/host-config/proxy';
import {
	type RedsocksConfig,
	type ProxyConfig,
	LegacyHostConfiguration,
	DnsInput,
} from '~/src/host-config/types';
import log from '~/lib/supervisor-console';

describe('RedsocksConf', () => {
	describe('stringify', () => {
		it('stringifies RedsocksConfig into config string', () => {
			const conf: RedsocksConfig = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: '"foo"',
					password: '"bar"',
				},
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}
			` + '\n',
			);
		});

		it('adds double quotes to auth fields if not exists', () => {
			const conf: RedsocksConfig = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
				},
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}
			` + '\n',
			);
		});

		it('accepts port field of type string', () => {
			const conf = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: '1080',
					login: 'foo',
					password: 'bar',
				},
			} as unknown as RedsocksConfig;
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}
			` + '\n',
			);
		});

		it('stringifies to empty string when provided empty RedsocksConfig', () => {
			const conf: RedsocksConfig = {};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal('');
		});

		it('stringifies to empty string when provided empty redsocks block', () => {
			const conf: RedsocksConfig = {
				redsocks: {} as ProxyConfig,
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal('');
		});

		it('stringifies dns to separate dnsu2t block', () => {
			const conf: RedsocksConfig = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: '"foo"',
					password: '"bar"',
					dns: '1.1.1.1:54',
				},
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 1.1.1.1;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
			` + '\n',
			);
		});

		it('stringifies dns: true to default dnsu2t config', () => {
			const conf: RedsocksConfig = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: '"foo"',
					password: '"bar"',
					dns: true,
				},
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}

				dnsu2t {
					remote_ip = 8.8.8.8;
					remote_port = 53;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
			` + '\n',
			);
		});

		it('does not include dnsu2t config if dns: false', () => {
			const conf: RedsocksConfig = {
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: '"foo"',
					password: '"bar"',
					dns: false,
				},
			};
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal(
				stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
					local_ip = 127.0.0.1;
					local_port = 12345;
				}
			` + '\n',
			);
		});

		it('does not stringify dnsu2t if no other fields in redsocks config', () => {
			const conf = {
				redsocks: {
					dns: '3.3.3.3:52',
				},
			} as RedsocksConfig;
			const confStr = RedsocksConf.stringify(conf);
			expect(confStr).to.equal('');
		});
	});

	describe('parse', () => {
		it('parses config string into RedsocksConfig', () => {
			const redsocksConfStr = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
				}

				dnstc {
					test = test;
				}

			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
				},
			});
		});

		it("parses `redsocks {...}` config block no matter what position it's in or how many newlines surround it", () => {
			const redsocksConfStr = stripIndent`
				dnstc {
					test = test;
				}
				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = http-connect;
					ip = {test2}.balenadev.io;
					port = 1082;
					login = "us}{er";
					password = "p{}a}}s{{s";
				}
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}
			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({
				redsocks: {
					type: 'http-connect',
					ip: '{test2}.balenadev.io',
					port: 1082,
					login: 'us}{er',
					password: 'p{}a}}s{{s',
				},
			});

			const redsocksConfStr2 = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = http-connect;
					ip = {test2}.balenadev.io;
					port = 1082;
					login = "us}{er";
					password = "p{}a}}s{{s";
				}`; // No newlines
			const conf2 = RedsocksConf.parse(redsocksConfStr2);
			expect(conf2).to.deep.equal({
				redsocks: {
					type: 'http-connect',
					ip: '{test2}.balenadev.io',
					port: 1082,
					login: 'us}{er',
					password: 'p{}a}}s{{s',
				},
			});
		});

		it('parses and removes double quotes around auth fields if present', async () => {
			const expected = {
				redsocks: {
					ip: 'example.org',
					login: 'user',
					password: 'pass',
					port: 1080,
					type: 'socks5',
				},
			};
			const confStr = stripIndent`
				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = user;
					password = pass;
				}
			`;
			const conf = RedsocksConf.parse(confStr);
			expect(conf).to.deep.equal(expected);

			const confStr2 = stripIndent`
				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "user;
					password = pass";
				}
			`;
			const conf2 = RedsocksConf.parse(confStr2);
			expect(conf2).to.deep.equal(expected);

			const confStr3 = stripIndent`
				redsocks {
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "user";
					password = "pass";
				}
			`;
			const conf3 = RedsocksConf.parse(confStr3);
			expect(conf3).to.deep.equal(expected);
		});

		it('parses to empty redsocks config with warnings while any values are invalid', () => {
			const redsocksConfStr = stripIndent`
				redsocks {
					local_ip = 123;
					local_port = foo;
					type = socks6;
					ip = 456;
					port = bar;
					login = user;
					password = pass;
					invalid_field = invalid_value;
				}
			`;
			(log.warn as SinonStub).resetHistory();
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect((log.warn as SinonStub).lastCall.args[0]).to.equal(
				'Invalid redsocks block in redsocks.conf:\n' +
					'Expecting NumericIdentifier at 0.port but instead got: "bar" (must be be an positive integer)\n' +
					'Expecting one of:\n' +
					'    "socks4"\n' +
					'    "socks5"\n' +
					'    "http-connect"\n' +
					'    "http-relay"\n' +
					'at 0.type but instead got: "socks6"',
			);
			(log.warn as SinonStub).resetHistory();
			expect(conf).to.deep.equal({});
		});

		it('parses to empty config with warnings while some key-value pairs are malformed', () => {
			// Malformed key-value pairs are pairs that are missing a key, value, or "="
			const redsocksConfStr = stripIndent`
				base {
					log_debug off;
					log_info = on
					= stderr;
					daemon = ;
					redirector = iptables;
				}

				redsocks {
					local_ip 127.0.0.1;
					local_port = 12345
					= socks5;
					ip = ;
					= 1080;
					login =;
					password = "bar";
				}
			`;
			(log.warn as SinonStub).resetHistory();
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(
				(log.warn as SinonStub).getCalls().map((call) => call.firstArg),
			).to.deep.equal([
				'Ignoring malformed redsocks.conf line "= socks5" due to missing key, value, or "="',
				'Ignoring malformed redsocks.conf line "ip =" due to missing key, value, or "="',
				'Ignoring malformed redsocks.conf line "= 1080" due to missing key, value, or "="',
				'Ignoring malformed redsocks.conf line "login" due to missing key, value, or "="',
				'Invalid redsocks block in redsocks.conf:\n' +
					'Expecting string at 0.ip but instead got: undefined\n' +
					'Expecting number at 0.port.0 but instead got: undefined\n' +
					'Expecting string at 0.port.1 but instead got: undefined\n' +
					'Expecting one of:\n' +
					'    "socks4"\n' +
					'    "socks5"\n' +
					'    "http-connect"\n' +
					'    "http-relay"\n' +
					'at 0.type but instead got: undefined',
			]);
			(log.warn as SinonStub).resetHistory();
			expect(conf).to.deep.equal({});
		});

		it('parses to empty config with warnings when a block is empty', () => {
			const redsocksConfStr = stripIndent`
				base {
				}

				redsocks {
				}
			`;
			(log.warn as SinonStub).resetHistory();
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(
				(log.warn as SinonStub).getCalls().map((call) => call.firstArg),
			).to.deep.equal([
				'Invalid redsocks block in redsocks.conf:\n' +
					'Expecting string at 0.ip but instead got: undefined\n' +
					'Expecting number at 0.port.0 but instead got: undefined\n' +
					'Expecting string at 0.port.1 but instead got: undefined\n' +
					'Expecting one of:\n' +
					'    "socks4"\n' +
					'    "socks5"\n' +
					'    "http-connect"\n' +
					'    "http-relay"\n' +
					'at 0.type but instead got: undefined',
			]);
			(log.warn as SinonStub).resetHistory();
			expect(conf).to.deep.equal({});
		});

		it('parses dnsu2t to dns field in redsocks config', () => {
			const redsocksConfStr = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
				}

				dnsu2t {
					remote_ip = 1.1.1.1;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
					dns: '1.1.1.1:54',
				},
			});
		});

		it('parses dnsu2t no matter its position', () => {
			const redsocksConfStr = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				dnsu2t {
					remote_ip = 1.1.1.1;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
				}
			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
					dns: '1.1.1.1:54',
				},
			});
		});

		it('does not parse dnsu2t to dns field if dnsu2t is partial or invalid', () => {
			const redsocksConfStr = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
				}

				dnsu2t {
					test = true;
				}
			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
				},
			});

			const redsocksConfStr2 = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					local_ip = 127.0.0.1;
					local_port = 12345;
					type = socks5;
					ip = example.org;
					port = 1080;
					login = "foo";
					password = "bar";
				}

				dnsu2t {
					remote_port = 53;
				}
			`;
			const conf2 = RedsocksConf.parse(redsocksConfStr2);
			expect(conf2).to.deep.equal({
				redsocks: {
					type: 'socks5',
					ip: 'example.org',
					port: 1080,
					login: 'foo',
					password: 'bar',
				},
			});
		});

		it('does not parse dnsu2t to dns field if missing or invalid redsocks config', () => {
			const redsocksConfStr = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				dnsu2t {
					remote_ip = 1.1.1.1;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
			`;
			const conf = RedsocksConf.parse(redsocksConfStr);
			expect(conf).to.deep.equal({});

			const redsocksConfStr2 = stripIndent`
				base {
					log_debug = off;
					log_info = on;
					log = stderr;
					daemon = off;
					redirector = iptables;
				}

				redsocks {
					type = socks5;
				}

				dnsu2t {
					remote_ip = 1.1.1.1;
					remote_port = 54;
					local_ip = 127.0.0.1;
					local_port = 53;
				}
			`;
			const conf2 = RedsocksConf.parse(redsocksConfStr2);
			expect(conf2).to.deep.equal({});
		});
	});
});

describe('src/host-config', () => {
	describe('parse', () => {
		it('parses valid HostConfiguration', () => {
			const conf = {
				network: {
					proxy: {
						type: 'socks4',
						ip: 'balena.io',
						port: 1079,
						login: '"baz"',
						password: '"foo"',
						noProxy: ['8.8.8.8'],
					},
					hostname: 'balena',
				},
			};
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
		});

		it('parses valid HostConfiguration with only hostname', () => {
			const conf = {
				network: {
					hostname: 'balena2',
				},
			};
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
		});

		it('parses valid HostConfiguration with only proxy', () => {
			const conf = {
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: 1081,
						login: '"foo"',
						password: '"bar"',
						noProxy: ['3.3.3.3'],
					},
				},
			};
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
		});

		it('parses valid HostConfiguration with only noProxy', () => {
			const conf = {
				network: {
					proxy: {
						noProxy: ['1.1.1.1', '2.2.2.2'],
					},
				},
			};
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
		});

		it('parses HostConfiguration where auth fields are missing double quotes', () => {
			const conf = {
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: 1081,
						login: 'foo',
						password: 'bar',
						noProxy: ['3.3.3.3'],
					},
				},
			};
			(log.warn as SinonStub).resetHistory();
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
			// Should not warn about missing double quotes
			expect(log.warn as SinonStub).to.not.have.been.called;
		});

		it('parses HostConfiguration where port is a string', () => {
			const conf = {
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: '1081',
						login: '"foo"',
						password: '"bar"',
						noProxy: ['3.3.3.3'],
					},
				},
			};
			(log.warn as SinonStub).resetHistory();
			expect(hostConfig.parse(conf)).to.deep.equal({
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: 1081,
						login: '"foo"',
						password: '"bar"',
						noProxy: ['3.3.3.3'],
					},
				},
			});
			// Should not warn about port being a string
			expect(log.warn as SinonStub).to.not.have.been.called;
		});

		// Allow invalid fields through for backwards compatibility
		it('parses input with invalid proxy as LegacyHostConfiguration with console warnings', () => {
			const conf = {
				network: {
					proxy: {
						type: 'socks6',
						ip: 123,
						port: 'abc',
						login: 'user',
						password: 'pass',
						noProxy: true,
					},
				},
			};
			(log.warn as SinonStub).resetHistory();
			expect(hostConfig.parse(conf)).to.deep.equal(conf);
			expect((log.warn as SinonStub).lastCall.args[0]).to.equal(
				'Malformed host config detected, things may not behave as expected:\n' +
					'Expecting string at network.proxy.0.0.ip but instead got: 123\n' +
					'Expecting NumericIdentifier at network.proxy.0.0.port but instead got: "abc" (must be be an positive integer)\n' +
					'Expecting one of:\n' +
					'    "socks4"\n' +
					'    "socks5"\n' +
					'    "http-connect"\n' +
					'    "http-relay"\n' +
					'at network.proxy.0.0.type but instead got: "socks6"\n' +
					'Expecting Array<string> at network.proxy.1.noProxy but instead got: true',
			);
			(log.warn as SinonStub).resetHistory();
		});

		it('throws error for HostConfiguration without network key', () => {
			expect(() => hostConfig.parse({})).to.throw(
				'Could not parse host config input to a valid format:\n' +
					'Expecting Partial<{| ' +
					'proxy: ({ [K in string]: any } & Partial<{ dns: (AddressString | boolean) }>), ' +
					'hostname: string ' +
					'|}> at network but instead got: undefined',
			);
		});

		it('throws error for HostConfiguration with invalid network key', () => {
			const conf = {
				network: 123,
			};
			expect(() => hostConfig.parse(conf)).to.throw(
				'Could not parse host config input to a valid format:\n' +
					'Expecting Partial<{| ' +
					'proxy: ({ [K in string]: any } & Partial<{ dns: (AddressString | boolean) }>), ' +
					'hostname: string ' +
					'|}> at network but instead got: 123',
			);
		});

		it('throws error for HostConfiguration with invalid hostname', () => {
			const conf = {
				network: {
					hostname: 123,
				},
			};
			expect(() => hostConfig.parse(conf)).to.throw(
				'Could not parse host config input to a valid format:\n' +
					'Expecting string at network.hostname but instead got: 123',
			);
		});

		it('throws error for HostConfiguration with invalid dns', () => {
			const invalids = [
				123, // wrong type
				'invalid-because-no-colon',
				':', // only colon
				':53', // missing address
				'1.1.1.1', // missing port
				'example.com:not-a-port', // wrong port type
			];
			for (const dns of invalids) {
				const conf = {
					network: {
						proxy: {
							type: 'http-connect',
							ip: 'test.balena.io',
							port: 1081,
							login: '"foo"',
							password: '"bar"',
							dns,
						},
					},
				};
				const formattedDns = typeof dns === 'string' ? `"${dns}"` : dns;
				expect(() => hostConfig.parse(conf)).to.throw(
					'Could not parse host config input to a valid format:\n' +
						'Expecting one of:\n' +
						'    AddressString\n' +
						'    boolean\n' +
						`at network.proxy.1.dns but instead got: ${formattedDns}`,
				);
			}
		});

		it('parses valid dns input', () => {
			const valids = ['balena.io:53', '1.1.1.1:5', 'balena.io:65535'];
			for (const dns of valids) {
				const conf = {
					network: {
						proxy: {
							type: 'http-connect',
							ip: 'test.balena.io',
							port: 1081,
							login: '"foo"',
							password: '"bar"',
							dns,
						},
					},
				};
				expect(hostConfig.parse(conf)).to.deep.equal(conf);
			}
		});

		it("strips additional inputs from HostConfiguration while not erroring if some optional inputs aren't present", () => {
			const conf = {
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: 1081,
						// login optional field present
						// but password optional field missing
						login: '"foo"',
						noProxy: ['2.2.2.2'],
						// local_* invalid fields present
						local_ip: '127.0.0.2',
						local_port: 1082,
						// extra key present
						extra1: 123,
					},
					// extra key present
					extra2: true,
				},
			};
			expect(hostConfig.parse(conf)).to.deep.equal({
				network: {
					proxy: {
						type: 'http-connect',
						ip: 'test.balena.io',
						port: 1081,
						login: '"foo"',
						noProxy: ['2.2.2.2'],
					},
				},
			});
		});
	});

	describe('types', () => {
		describe('DnsInput', () => {
			it('decodes to DnsInput boolean', () => {
				expect(DnsInput.is(true)).to.be.true;
				expect(DnsInput.is(false)).to.be.true;
			});

			it('decodes to DnsInput from string in the format "ADDRESS:PORT"', () => {
				expect(DnsInput.is('1.2.3.4:53')).to.be.true;
				expect(DnsInput.is('example.com:53')).to.be.true;
			});

			it('does not decode to DnsInput from invalid string', () => {
				expect(DnsInput.is('')).to.be.false;
				expect(DnsInput.is(':')).to.be.false;
				expect(DnsInput.is('1.2.3.4:')).to.be.false;
				expect(DnsInput.is(':53')).to.be.false;
				expect(DnsInput.is('example.com:')).to.be.false;
				expect(DnsInput.is('1.2.3.4')).to.be.false;
				expect(DnsInput.is('example.com')).to.be.false;
			});
		});

		describe('LegacyHostConfiguration', () => {
			it('maintains strict dns typing for LegacyHostConfiguration', () => {
				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: 123,
							},
						},
					}),
				).to.be.false;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: '1.1.1.1:53',
							},
						},
					}),
				).to.be.true;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: true,
							},
						},
					}),
				).to.be.true;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: false,
							},
						},
					}),
				).to.be.true;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: '',
							},
						},
					}),
				).to.be.false;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: ':53',
							},
						},
					}),
				).to.be.false;

				expect(
					LegacyHostConfiguration.is({
						network: {
							proxy: {
								legacy: 'field',
								dns: '1.1.1.1',
							},
						},
					}),
				).to.be.false;
			});
		});
	});
});
