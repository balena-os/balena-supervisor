import { expect } from 'chai';
import { stripIndent } from 'common-tags';
import type { SinonStub } from 'sinon';

import * as hostConfig from '~/src/host-config/index';
import log from '~/lib/supervisor-console';

describe('RedsocksConf', () => {
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
			const conf = hostConfig.RedsocksConf.parse(redsocksConfStr);
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
				dnsu2t {
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
			const conf = hostConfig.RedsocksConf.parse(redsocksConfStr);
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
			const conf2 = hostConfig.RedsocksConf.parse(redsocksConfStr2);
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
			const conf = hostConfig.RedsocksConf.parse(confStr);
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
			const conf2 = hostConfig.RedsocksConf.parse(confStr2);
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
			const conf3 = hostConfig.RedsocksConf.parse(confStr3);
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
			const conf = hostConfig.RedsocksConf.parse(redsocksConfStr);
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
			const conf = hostConfig.RedsocksConf.parse(redsocksConfStr);
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
			const conf = hostConfig.RedsocksConf.parse(redsocksConfStr);
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
	});
});
