import { expect } from 'chai';
import * as ComposeUtils from '~/src/compose/utils';

describe('compose/utils', () => {
	it('should correctly camel case the configuration', () => {
		const config = {
			restart: 'always',
			stop_signal: 'SIGTERM',
			networks: ['test', 'test2'],
		};

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			restart: 'always',
			stopSignal: 'SIGTERM',
			networks: ['test', 'test2'],
		});
	});

	it('should camel case healthcheck keys', () => {
		const config = {
			healthcheck: {
				test: ['CMD', 'true'],
				interval: '10s',
				start_period: '30s',
				retries: 3,
			},
		};

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			healthcheck: {
				test: ['CMD', 'true'],
				interval: '10s',
				startPeriod: '30s',
				retries: 3,
			},
		});
	});

	it('should not fail if the healthcheck is not an object', () => {
		const config = { healthcheck: null };

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			healthcheck: null,
		});
	});

	it('should camel case the keys of networks defined as an object', () => {
		const config = {
			networks: {
				default: {
					ipv4_address: '172.20.0.2',
					link_local_ips: ['169.254.1.1'],
				},
				other: {},
			},
		};

		expect(ComposeUtils.camelCaseConfig(config)).to.deep.equal({
			networks: {
				default: {
					ipv4Address: '172.20.0.2',
					linkLocalIps: ['169.254.1.1'],
				},
				other: {},
			},
		});
	});
});
