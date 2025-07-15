import _ from 'lodash';

import * as config from '../config/index';
import * as constants from './constants';
import * as iptables from './iptables';
import { log } from './supervisor-console';
import { logSystemMessage } from '../logging';

import * as dbFormat from '../device-state/db-format';

export const initialised = _.once(async () => {
	await config.initialized();
	await applyFirewall();

	// apply firewall whenever relevant config changes occur...
	config.on('change', ({ firewallMode, localMode }) => {
		if (firewallMode || localMode != null) {
			void applyFirewall({ firewallMode, localMode });
		}
	});
});

const BALENA_FIREWALL_CHAIN = 'BALENA-FIREWALL';
const BALENA_SUPERVISOR_CHAIN = 'BALENA-SUPERVISOR';

const prepareChain: iptables.Rule[] = [
	{
		action: iptables.RuleAction.Flush,
	},
];

const standardServices: iptables.Rule[] = [
	{
		comment: 'SSH Server',
		action: iptables.RuleAction.Append,
		proto: 'tcp',
		matches: ['--dport 22222'],
		target: 'ACCEPT',
	},
	{
		comment: 'balenaEngine',
		action: iptables.RuleAction.Append,
		proto: 'tcp',
		matches: ['--dport 2375'],
		target: 'ACCEPT',
	},
	{
		comment: 'mDNS',
		action: iptables.RuleAction.Append,
		matches: ['-m addrtype', '--dst-type MULTICAST'],
		target: 'ACCEPT',
	},
	{
		comment: 'ICMP',
		action: iptables.RuleAction.Append,
		proto: 'icmp',
		target: 'ACCEPT',
	},
	{
		comment: 'DNS from balena0',
		action: iptables.RuleAction.Append,
		proto: 'udp',
		matches: ['--dport 53', '-i balena0'],
		target: 'ACCEPT',
	},
	{
		comment: 'DNS from custom Engine networks',
		action: iptables.RuleAction.Append,
		proto: 'udp',
		matches: ['--dport 53', '-i br+'],
		target: 'ACCEPT',
	},
];

const standardPolicy: iptables.Rule[] = [
	{
		comment: 'Locally-sourced traffic',
		action: iptables.RuleAction.Insert,
		matches: ['-m addrtype', '--src-type LOCAL'],
		target: 'ACCEPT',
	},
	{
		action: iptables.RuleAction.Insert,
		matches: ['-m state', '--state ESTABLISHED,RELATED'],
		target: 'ACCEPT',
	},
];

let supervisorAccessRules: iptables.Rule[] = [];
function updateSupervisorAccessRules(
	localMode: boolean,
	interfaces: string[],
	port: number,
	overridePort?: number | null,
) {
	supervisorAccessRules = [];

	// if there is an override port set, then just allow traffic on the supervisor0
	// interface to the override port
	if (overridePort != null) {
		// Allow traffic on the override port on the supervisor0 interface
		supervisorAccessRules.push({
			comment: 'Supervisor API',
			action: iptables.RuleAction.Append,
			proto: 'tcp',
			matches: [
				`--dport ${overridePort}`,
				`-i ${constants.supervisorNetworkInterface}`,
			],
			target: 'ACCEPT',
		});

		// now block access to the port for any interface, since the above should have allowed legitimate traffic...
		supervisorAccessRules.push({
			comment: 'Supervisor API',
			action: iptables.RuleAction.Append,
			proto: 'tcp',
			matches: [`--dport ${overridePort}`],
			target: 'REJECT',
		});
		// otherwise configure traffic to the supervisor API port
	} else {
		// if localMode then add a dummy interface placeholder, otherwise add each interface...
		const matchesIntf = localMode
			? [[]]
			: interfaces.map((intf) => [`-i ${intf}`]);
		matchesIntf.forEach((intf) =>
			supervisorAccessRules.push({
				comment: 'Supervisor API',
				action: iptables.RuleAction.Append,
				proto: 'tcp',
				matches: [`--dport ${port}`, ...intf],
				target: 'ACCEPT',
			}),
		);

		// now block access to the port for any interface, since the above should have allowed legitimate traffic...
		supervisorAccessRules.push({
			comment: 'Supervisor API',
			action: iptables.RuleAction.Append,
			proto: 'tcp',
			matches: [`--dport ${port}`],
			target: 'REJECT',
		});
	}
}

let supervisorOverrideAccessRules: iptables.Rule[] = [];
function updateSupervisorOverrideAccessRules(
	localMode: boolean,
	port: number,
	overridePort?: number | null,
) {
	supervisorOverrideAccessRules = [];

	// if the override port is set, we assume the regular API port
	// is controlled by the docker firewall, so we just need to add a
	// couple of rules for backwards compatibility. This means
	// allowing traffic only for the resin-vpn interface when in non local-mode
	if (overridePort != null && !localMode) {
		supervisorOverrideAccessRules.push({
			comment: 'Supervisor API override',
			action: iptables.RuleAction.Append,
			proto: 'tcp',
			matches: [`--dport ${port}`, `-i resin-vpn`],
			target: 'ACCEPT',
			family: 4,
		});

		// block access to the port for anything else
		supervisorOverrideAccessRules.push({
			comment: 'Supervisor API override',
			action: iptables.RuleAction.Append,
			proto: 'tcp',
			matches: [`--dport ${port}`],
			target: 'REJECT',
			family: 4,
		});
	}
}

async function runningHostBoundServices(): Promise<boolean> {
	const apps = await dbFormat.getApps();

	return _(apps).some((app) =>
		_(app.services).some((svc) => svc.config.networkMode === 'host'),
	);
}

async function applyFirewall(
	opts?: Partial<{ firewallMode: string | null; localMode: boolean }>,
) {
	// grab the current config...
	const currentConfig = await config.getMany([
		'listenPort',
		'listenPortOverride',
		'firewallMode',
		'localMode',
	]);

	// populate missing config elements...
	const { listenPort, listenPortOverride, firewallMode, localMode } = {
		...opts,
		...currentConfig,
	};

	// update the Supervisor API access rules...
	updateSupervisorAccessRules(
		localMode,
		constants.allowedInterfaces,
		listenPort,
		listenPortOverride,
	);

	// update the Supervisor API override rules
	updateSupervisorOverrideAccessRules(
		localMode,
		listenPort,
		listenPortOverride,
	);

	// apply the firewall rules...
	await exports.applyFirewallMode(firewallMode ?? '');
}

export const ALLOWED_MODES = ['on', 'off', 'auto'];

export async function applyFirewallMode(mode: string) {
	// only apply valid mode...
	if (!ALLOWED_MODES.includes(mode)) {
		log.warn(`Invalid firewall mode: ${mode}. Reverting to state: off`);
		mode = 'off';
	}

	log.info(`Applying firewall mode: ${mode}`);

	try {
		// are we running services in host-network mode?
		const isServicesInHostNetworkMode = await runningHostBoundServices();

		// should we allow only traffic to the balena host services?
		const returnIfOff: iptables.Rule | iptables.Rule[] =
			mode === 'off' || (mode === 'auto' && !isServicesInHostNetworkMode)
				? {
						comment: `Firewall disabled (${mode})`,
						action: iptables.RuleAction.Append,
						target: 'RETURN',
					}
				: [];

		// Get position of BALENA-FIREWALL rule in the INPUT chain for both iptables & ip6tables
		const balenaFirewallPositionV4 = await iptables.getRulePosition(
			'INPUT',
			BALENA_FIREWALL_CHAIN,
			4,
		);
		const balenaFirewallPositionV6 = await iptables.getRulePosition(
			'INPUT',
			BALENA_FIREWALL_CHAIN,
			6,
		);

		// Get position of BALENA-SUPERVISOR rule in the DOCKER-USER chain
		const balenaSupervisorChainIsSet =
			(await iptables.getRulePosition(
				'DOCKER-USER',
				BALENA_SUPERVISOR_CHAIN,
				4,
			)) > 0;

		// get an adaptor to manipulate iptables rules...
		const ruleAdaptor = iptables.getDefaultRuleAdaptor();

		// configure the BALENA-FIREWALL chain...
		await iptables
			.build()
			.forTable('filter', (filter) =>
				filter
					.forChain('INPUT', (chain) => {
						// Delete & insert to v4 tables
						if (balenaFirewallPositionV4 !== -1) {
							chain.addRule({
								action: iptables.RuleAction.Delete,
								target: BALENA_FIREWALL_CHAIN,
								family: 4,
							});
						}
						chain.addRule({
							action: iptables.RuleAction.Insert,
							id: balenaFirewallPositionV4 > 0 ? balenaFirewallPositionV4 : 1,
							target: BALENA_FIREWALL_CHAIN,
							family: 4,
						});
						// Delete & insert to v6 tables
						if (balenaFirewallPositionV6 !== -1) {
							chain.addRule({
								action: iptables.RuleAction.Delete,
								target: BALENA_FIREWALL_CHAIN,
								family: 6,
							});
						}
						chain.addRule({
							action: iptables.RuleAction.Insert,
							id: balenaFirewallPositionV6 > 0 ? balenaFirewallPositionV6 : 1,
							target: BALENA_FIREWALL_CHAIN,
							family: 6,
						});
						return chain;
					})
					.forChain(BALENA_FIREWALL_CHAIN, (chain) =>
						chain
							.addRule(prepareChain)
							.addRule(supervisorAccessRules)
							.addRule(standardServices)
							.addRule(standardPolicy)
							.addRule(returnIfOff)
							.addRule({
								comment: 'Reject everything else',
								action: iptables.RuleAction.Append,
								target: 'REJECT',
							}),
					)
					.forChain('DOCKER-USER', (chain) => {
						// Add the supervisor chain if not added
						if (!balenaSupervisorChainIsSet) {
							chain.addRule({
								action: iptables.RuleAction.Append,
								target: BALENA_SUPERVISOR_CHAIN,
								family: 4,
							});
						}

						return chain;
					})
					.forChain(BALENA_SUPERVISOR_CHAIN, (chain) =>
						chain.addRule(prepareChain).addRule(supervisorOverrideAccessRules),
					),
			)
			.apply(ruleAdaptor);

		// all done!
		log.success(`Firewall mode applied`);
	} catch (err) {
		logSystemMessage(`Firewall mode not applied due to error`);
		log.error(`Firewall mode not applied`);
		log.error('Error applying firewall mode', err);

		if (err instanceof iptables.IPTablesRuleError) {
			log.debug(`Ruleset:\r\n${err.ruleset}`);
		}
	}
}
