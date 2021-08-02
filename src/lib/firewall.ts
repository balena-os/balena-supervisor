import * as _ from 'lodash';

import * as config from '../config/index';
import * as constants from './constants';
import * as iptables from './iptables';
import { log } from './supervisor-console';
import { logSystemMessage } from '../logger';

import * as dbFormat from '../device-state/db-format';

export const initialised = (async () => {
	await config.initialized;
	await applyFirewall();

	// apply firewall whenever relevant config changes occur...
	config.on('change', ({ firewallMode, localMode }) => {
		if (firewallMode || localMode != null) {
			applyFirewall({ firewallMode, localMode });
		}
	});
})();

const BALENA_FIREWALL_CHAIN = 'BALENA-FIREWALL';

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
		comment: 'DNS',
		action: iptables.RuleAction.Append,
		proto: 'udp',
		matches: ['--dport 53', '-i balena0'],
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
) {
	supervisorAccessRules = [];

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
		'firewallMode',
		'localMode',
	]);

	// populate missing config elements...
	const { listenPort, firewallMode, localMode } = {
		...opts,
		...currentConfig,
	};

	// update the Supervisor API access rules...
	updateSupervisorAccessRules(
		localMode,
		constants.allowedInterfaces,
		listenPort,
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

		// get an adaptor to manipulate iptables rules...
		const ruleAdaptor = iptables.getDefaultRuleAdaptor();

		// configure the BALENA-FIREWALL chain...
		await iptables
			.build()
			.forTable('filter', (filter) =>
				filter
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
					.forChain('INPUT', (chain) =>
						chain
							.addRule({
								action: iptables.RuleAction.Flush,
							})
							.addRule({
								action: iptables.RuleAction.Append,
								target: 'BALENA-FIREWALL',
							}),
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
