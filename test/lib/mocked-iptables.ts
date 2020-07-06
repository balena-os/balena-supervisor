import _ = require('lodash');
import { expect } from 'chai';

import * as firewall from '../../src/lib/firewall';
import * as iptables from '../../src/lib/iptables';
import { EventEmitter } from 'events';

class FakeRuleAdaptor {
	private rules: iptables.Rule[];

	constructor() {
		this.rules = [];
	}

	public getRuleAdaptor(): iptables.RuleAdaptor {
		return this.ruleAdaptor.bind(this);
	}

	private async ruleAdaptor(rules: iptables.Rule[]): Promise<void> {
		const handleRule = async (rule: iptables.Rule) => {
			// remove any undefined values from the object...
			for (const key of Object.getOwnPropertyNames(rule)) {
				if ((rule as any)[key] === undefined) {
					delete (rule as any)[key];
				}
			}

			this.rules.push(rule);
			return '';
		};

		if (_.isArray(rules)) {
			for (const rule of rules) {
				await handleRule(rule);
			}
		}
	}

	private isSameRule(
		partial: Partial<iptables.Rule>,
		rule: iptables.Rule,
	): boolean {
		const props = Object.getOwnPropertyNames(partial);
		for (const prop of props) {
			if (
				_.get(rule, prop) === undefined ||
				!_.isEqual(_.get(rule, prop), _.get(partial, prop))
			) {
				return false;
			}
		}

		return true;
	}

	public expectRule(testRule: Partial<iptables.Rule>) {
		return expect(
			_.some(this.rules, (r) => this.isSameRule(testRule, r)),
		).to.eq(
			true,
			`Rule has not been applied: ${JSON.stringify(
				testRule,
			)}\n\n${JSON.stringify(this.rules, null, 2)}`,
		);
	}
	public expectNoRule(testRule: Partial<iptables.Rule>) {
		return expect(
			_.some(this.rules, (r) => this.isSameRule(testRule, r)),
		).to.eq(
			false,
			`Rule has been applied: ${JSON.stringify(testRule)}\n\n${JSON.stringify(
				this.rules,
				null,
				2,
			)}`,
		);
	}
	public clearHistory() {
		this.rules = [];
	}
}

const fakeRuleAdaptor = new FakeRuleAdaptor();
// @ts-expect-error Assigning to a RO property
iptables.getDefaultRuleAdaptor = () => fakeRuleAdaptor.getRuleAdaptor();

export interface MockedState {
	hasAppliedRules: Promise<void>;
	expectRule: (rule: iptables.Rule) => void;
	expectNoRule: (rule: iptables.Rule) => void;
	clearHistory: () => void;
}

export type MockedConext = (state: MockedState) => Promise<any>;

const applyFirewallRules = firewall.applyFirewallMode;
export const whilstMocked = async (context: MockedConext) => {
	fakeRuleAdaptor.clearHistory();

	const applied = new EventEmitter();

	// @ts-expect-error Assigning to a RO property
	firewall.applyFirewallMode = async (mode: string) => {
		await applyFirewallRules(mode);
		applied.emit('applied');
	};

	await context({
		expectRule: (rule) => fakeRuleAdaptor.expectRule(rule),
		expectNoRule: (rule) => fakeRuleAdaptor.expectNoRule(rule),
		clearHistory: () => fakeRuleAdaptor.clearHistory(),
		hasAppliedRules: new Promise((resolve) => {
			applied.once('applied', () => resolve());
		}),
	});

	// @ts-expect-error Assigning to a RO property
	firewall.applyFirewallMode = applyFirewallRules;
};
