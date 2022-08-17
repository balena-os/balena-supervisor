import _ = require('lodash');
import { expect } from 'chai';
import { stub } from 'sinon';
import * as childProcess from 'child_process';

import * as firewall from '~/lib/firewall';
import * as iptables from '~/lib/iptables';
import { EventEmitter } from 'events';
import { Writable } from 'stream';

export enum RuleProperty {
	NotSet,
}

export type Testable<T> = { [P in keyof T]?: T[P] | RuleProperty | undefined };

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
		testable: Testable<iptables.Rule>,
		rule: iptables.Rule,
	): boolean {
		const props = Object.getOwnPropertyNames(testable);
		for (const prop of props) {
			if (
				_.get(testable, prop) === RuleProperty.NotSet &&
				_.get(rule, prop) === undefined
			) {
				return true;
			}

			if (
				_.get(rule, prop) === undefined ||
				!_.isEqual(_.get(rule, prop), _.get(testable, prop))
			) {
				return false;
			}
		}

		return true;
	}

	public expectRule(testRule: Testable<iptables.Rule>) {
		const matchingIndex = (() => {
			for (let i = 0; i < this.rules.length; i++) {
				if (this.isSameRule(testRule, this.rules[i])) {
					return i;
				}
			}
			return -1;
		})();

		if (matchingIndex < 0) {
			console.log({ testRule, rules: this.rules });
		}

		expect(matchingIndex).to.be.greaterThan(-1, `Rule has not been applied`);

		return matchingIndex;
	}
	public expectNoRule(testRule: Testable<iptables.Rule>) {
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

export const realRuleAdaptor = iptables.getDefaultRuleAdaptor();

const fakeRuleAdaptorManager = new FakeRuleAdaptor();
const fakeRuleAdaptor = fakeRuleAdaptorManager.getRuleAdaptor();

// @ts-expect-error Assigning to a RO property
iptables.getDefaultRuleAdaptor = () => {
	return fakeRuleAdaptor;
};

export interface MockedState {
	hasAppliedRules: Promise<void>;
	expectRule: (rule: Testable<iptables.Rule>) => number;
	expectNoRule: (rule: Testable<iptables.Rule>) => void;
	clearHistory: () => void;
}

export type MockedConext = (state: MockedState) => Promise<any>;

const applyFirewallRules = firewall.applyFirewallMode;
export const whilstMocked = async (
	context: MockedConext,
	ruleAdaptor: iptables.RuleAdaptor = fakeRuleAdaptor,
) => {
	const getOriginalDefaultRuleAdaptor = iptables.getDefaultRuleAdaptor;

	const spawnStub = stub(childProcess, 'spawn').callsFake(() => {
		const fakeProc = new EventEmitter();
		(fakeProc as any).stdout = new EventEmitter();

		const stdin = new Writable();
		stdin._write = (
			chunk: Buffer,
			_encoding: string,
			callback: (err?: Error) => void,
		) => {
			console.log(chunk.toString('utf8'));
			callback();
			fakeProc.emit('close', 1);
		};
		(fakeProc as any).stdin = stdin;

		return fakeProc as any;
	});

	// @ts-expect-error Assigning to a RO property
	iptables.getDefaultRuleAdaptor = () => {
		return ruleAdaptor;
	};

	fakeRuleAdaptorManager.clearHistory();

	const applied = new EventEmitter();

	// @ts-expect-error Assigning to a RO property
	firewall.applyFirewallMode = async (mode: string) => {
		await applyFirewallRules(mode);
		applied.emit('applied');
	};

	await context({
		expectRule: (rule) => fakeRuleAdaptorManager.expectRule(rule),
		expectNoRule: (rule) => fakeRuleAdaptorManager.expectNoRule(rule),
		clearHistory: () => fakeRuleAdaptorManager.clearHistory(),
		hasAppliedRules: new Promise((resolve) => {
			applied.once('applied', () => resolve());
		}),
	});

	// @ts-expect-error Assigning to a RO property
	firewall.applyFirewallMode = applyFirewallRules;

	spawnStub.restore();

	// @ts-expect-error Assigning to a RO property
	iptables.getDefaultRuleAdaptor = getOriginalDefaultRuleAdaptor;
};
