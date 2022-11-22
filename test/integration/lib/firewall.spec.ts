import _ from 'lodash';
import { expect } from 'chai';

import * as sinon from 'sinon';

import * as config from '~/src/config';
import * as firewall from '~/lib/firewall';
import * as logger from '~/src/logger';
import * as iptablesMock from '~/test-lib/mocked-iptables';
import * as dbFormat from '~/src/device-state/db-format';

import constants from '~/lib/constants';
import { RuleAction, Rule } from '~/lib/iptables';
import { log } from '~/lib/supervisor-console';

describe('lib/firewall', function () {
	let loggerSpy: sinon.SinonSpy;
	let logSpy: sinon.SinonStub;

	let apiEndpoint: string;
	let listenPort: number;

	before(async () => {
		await config.initialized();

		// spy the logs...
		loggerSpy = sinon.spy(logger, 'logSystemMessage');
		logSpy = log.error as sinon.SinonStub;

		await firewall.initialised();

		apiEndpoint = await config.get('apiEndpoint');
		listenPort = await config.get('listenPort');
	});

	after(async () => {
		loggerSpy.restore();
	});

	describe('Basic On/Off operation', () => {
		it('should confirm the `changed` event is handled', async function () {
			await iptablesMock.whilstMocked(async ({ hasAppliedRules }) => {
				const changedSpy = sinon.spy();
				config.on('change', changedSpy);

				// set the firewall to be in off mode...
				await config.set({ firewallMode: 'off' });
				await hasAppliedRules;

				// check it fired the events correctly...
				expect(changedSpy.called).to.be.true;
				expect(changedSpy.calledWith({ firewallMode: 'off' })).to.be.true;
			});
		});

		it('should handle the HOST_FIREWALL_MODE configuration value: invalid', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be in off mode...
					await config.set({ firewallMode: 'invalid' });
					await hasAppliedRules;

					// expect that we jump to the firewall chain...
					expectRule({
						target: 'BALENA-FIREWALL',
						chain: 'INPUT',
						family: 4,
					});

					// expect to return...
					expectRule({
						chain: 'BALENA-FIREWALL',
						target: 'RETURN',
						family: 4,
					});
				},
			);
		});

		it('should respect the HOST_FIREWALL_MODE configuration value: off', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be in off mode...
					await config.set({ firewallMode: 'off' });
					await hasAppliedRules;

					// expect that we jump to the firewall chain...
					expectRule({
						action: RuleAction.Append,
						target: 'BALENA-FIREWALL',
						chain: 'INPUT',
						family: 4,
					});

					// expect to return...
					const returnRuleIdx = expectRule({
						table: 'filter',
						chain: 'BALENA-FIREWALL',
						target: 'RETURN',
						family: 4,
					});

					// ... just before we reject everything
					const rejectRuleIdx = expectRule({
						chain: 'BALENA-FIREWALL',
						target: 'REJECT',
						matches: iptablesMock.RuleProperty.NotSet,
						family: 4,
					});

					expect(returnRuleIdx).to.be.lessThan(rejectRuleIdx);
				},
			);
		});

		it('should respect the HOST_FIREWALL_MODE configuration value: on', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule, expectNoRule }) => {
					// set the firewall to be in auto mode...
					await config.set({ firewallMode: 'on' });
					await hasAppliedRules;

					// expect that we jump to the firewall chain...
					expectRule({
						action: RuleAction.Append,
						target: 'BALENA-FIREWALL',
						chain: 'INPUT',
						family: 4,
					});

					// expect to not return for any reason...
					expectNoRule({
						chain: 'BALENA-FIREWALL',
						target: 'RETURN',
					});
				},
			);
		});

		it('should respect the HOST_FIREWALL_MODE configuration value: auto (no services in host-network)', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					await dbFormat.setApps(
						{
							myapp: {
								id: 2,
								name: 'test-app2',
								class: 'fleet',
								is_host: false,
								releases: {
									abcdef2: {
										id: 1232,
										services: {
											'test-service': {
												id: 567,
												image: 'test-image',
												image_id: 5,
												environment: {
													TEST_VAR: 'test-string',
												},
												labels: {},
												composition: {
													tty: true,
												},
											},
										},
										networks: {},
										volumes: {},
									},
								},
							},
						},
						apiEndpoint,
					);

					// set the firewall to be in auto mode...
					await config.set({ firewallMode: 'auto' });
					await hasAppliedRules;

					// expect that we jump to the firewall chain...
					expectRule({
						action: RuleAction.Append,
						target: 'BALENA-FIREWALL',
						chain: 'INPUT',
						family: 4,
					});

					// expect to return...
					expectRule({
						chain: 'BALENA-FIREWALL',
						target: 'RETURN',
						family: 4,
					});
				},
			);
		});

		it('should respect the HOST_FIREWALL_MODE configuration value: auto (service in host-network)', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule, expectNoRule }) => {
					await dbFormat.setApps(
						{
							myapp: {
								id: 2,
								name: 'test-app2',
								class: 'fleet',
								is_host: false,
								releases: {
									abcdef2: {
										id: 1232,
										services: {
											'test-service': {
												id: 567,
												image: 'test-image',
												image_id: 5,
												environment: {
													TEST_VAR: 'test-string',
												},
												labels: {},
												composition: {
													tty: true,
													network_mode: 'host',
												},
											},
										},
										networks: {},
										volumes: {},
									},
								},
							},
						},
						apiEndpoint,
					);

					// set the firewall to be in auto mode...
					await config.set({ firewallMode: 'auto' });
					await hasAppliedRules;

					// expect that we jump to the firewall chain...
					expectRule({
						action: RuleAction.Append,
						target: 'BALENA-FIREWALL',
						chain: 'INPUT',
						family: 4,
					});

					// expect to return...
					expectNoRule({
						chain: 'BALENA-FIREWALL',
						target: 'RETURN',
						family: 4,
					});
				},
			);
		});

		it('should catch errors when rule changes fail', async () => {
			await iptablesMock.whilstMocked(async ({ hasAppliedRules }) => {
				// clear the spies...
				loggerSpy.resetHistory();
				logSpy.resetHistory();

				// set the firewall to be in off mode...
				await config.set({ firewallMode: 'off' });
				await hasAppliedRules;

				// should have caught the error and logged it
				expect(logSpy.calledWith('Error applying firewall mode')).to.be.true;
				expect(loggerSpy.called).to.be.true;
			}, iptablesMock.realRuleAdaptor);
		});
	});

	describe('Service rules', () => {
		const rejectAllRule = {
			target: 'REJECT',
			chain: 'BALENA-FIREWALL',
			matches: iptablesMock.RuleProperty.NotSet,
		};

		const checkForRules = (
			rules: Array<iptablesMock.Testable<Rule>> | iptablesMock.Testable<Rule>,
			expectRule: (rule: iptablesMock.Testable<Rule>) => number,
		) => {
			rules = _.castArray(rules);
			rules.forEach((rule) => {
				const ruleIdx = expectRule(rule);

				// make sure we reject AFTER the rule...
				const rejectAllRuleIdx = expectRule(rejectAllRule);
				expect(ruleIdx).is.lessThan(rejectAllRuleIdx);
			});
		};

		it('should have a rule to allow DNS traffic from the balena0 interface', async () => {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be on...
					await config.set({ firewallMode: 'on' });
					await hasAppliedRules;

					[4, 6].forEach((family: 4 | 6) => {
						// expect that we have a rule to allow DNS access...
						checkForRules(
							{
								family,
								target: 'ACCEPT',
								chain: 'BALENA-FIREWALL',
								proto: 'udp',
								matches: ['--dport 53', '-i balena0'],
							},
							expectRule,
						);
					});
				},
			);
		});

		it('should have a rule to allow SSH traffic any interface', async () => {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be on...
					await config.set({ firewallMode: 'on' });
					await hasAppliedRules;

					[4, 6].forEach((family: 4 | 6) => {
						// expect that we have a rule to allow SSH access...
						checkForRules(
							{
								family,
								target: 'ACCEPT',
								chain: 'BALENA-FIREWALL',
								proto: 'tcp',
								matches: ['--dport 22222'],
							},
							expectRule,
						);
					});
				},
			);
		});

		it('should have a rule to allow Multicast traffic any interface', async () => {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be on...
					await config.set({ firewallMode: 'on' });
					await hasAppliedRules;

					[4, 6].forEach((family: 4 | 6) => {
						// expect that we have a rule to allow multicast...
						checkForRules(
							{
								family,
								target: 'ACCEPT',
								chain: 'BALENA-FIREWALL',
								matches: ['-m addrtype', '--dst-type MULTICAST'],
							},
							expectRule,
						);
					});
				},
			);
		});

		it('should have a rule to allow balenaEngine traffic any interface', async () => {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the firewall to be on...
					await config.set({ firewallMode: 'on' });
					await hasAppliedRules;

					[4, 6].forEach((family: 4 | 6) => {
						// expect that we have a rule to allow balenaEngine access...
						checkForRules(
							{
								family,
								target: 'ACCEPT',
								chain: 'BALENA-FIREWALL',
								proto: 'tcp',
								matches: ['--dport 2375'],
							},
							expectRule,
						);
					});
				},
			);
		});
	});

	describe('Supervisor API access', () => {
		it('should allow access in localmode', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule }) => {
					// set the device to be in local mode...
					await config.set({ localMode: true });
					await hasAppliedRules;

					[4, 6].forEach((family: 4 | 6) => {
						// make sure we have a rule to allow traffic on ANY interface
						const allowRuleIdx = expectRule({
							proto: 'tcp',
							matches: [`--dport ${listenPort}`],
							target: 'ACCEPT',
							chain: 'BALENA-FIREWALL',
							table: 'filter',
							family,
						});

						// make sure we have a rule to block traffic on ANY interface also
						const rejectRuleIdx = expectRule({
							proto: 'tcp',
							matches: [`--dport ${listenPort}`],
							target: 'REJECT',
							chain: 'BALENA-FIREWALL',
							table: 'filter',
							family,
						});

						// we should always reject AFTER we allow
						expect(allowRuleIdx).to.be.lessThan(rejectRuleIdx);
					});
				},
			);
		});

		it('should allow limited access in non-localmode', async function () {
			await iptablesMock.whilstMocked(
				async ({ hasAppliedRules, expectRule, expectNoRule }) => {
					// set the device to be in local mode...
					await config.set({ localMode: false });
					await hasAppliedRules;

					// ensure we have no unrestricted rule...
					expectNoRule({
						chain: 'BALENA-FIREWALL',
						proto: 'tcp',
						matches: [`--dport ${listenPort}`],
						target: 'ACCEPT',
						family: 4,
					});

					// ensure we do have a restricted rule for each interface...
					let allowRuleIdx = -1;
					constants.allowedInterfaces.forEach((intf) => {
						[4, 6].forEach((family: 4 | 6) => {
							allowRuleIdx = expectRule({
								chain: 'BALENA-FIREWALL',
								proto: 'tcp',
								matches: [`--dport ${listenPort}`, `-i ${intf}`],
								target: 'ACCEPT',
								family,
							});
						});
					});

					// make sure we have a rule to block traffic on ANY interface also
					const rejectRuleIdx = expectRule({
						proto: 'tcp',
						matches: [`--dport ${listenPort}`],
						target: 'REJECT',
						chain: 'BALENA-FIREWALL',
						table: 'filter',
					});

					// we should always reject AFTER we allow
					expect(allowRuleIdx).to.be.lessThan(rejectRuleIdx);
				},
			);
		});
	});
});
