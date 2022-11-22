import _ from 'lodash';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { TypedError } from 'typed-error';

export class IPTablesRuleError extends TypedError {
	public constructor(err: string | Error, public ruleset: string) {
		super(err);
	}
}

export enum RuleAction {
	Insert = '-I',
	Append = '-A',
	Flush = '-F',
}
export interface Rule {
	id?: number;
	family?: 4 | 6;
	action?: RuleAction;
	target?: 'ACCEPT' | 'BLOCK' | 'REJECT' | string;
	chain?: string;
	table?: 'filter' | string;
	proto?: 'all' | any;
	src?: string;
	dest?: string;
	matches?: string[];
	comment?: string;
}

export type RuleAdaptor = (rules: Rule[]) => Promise<void>;
export interface RuleBuilder {
	addRule: (rules: Rule | Rule[]) => RuleBuilder;
}

export interface ChainBuilder {
	forChain: (
		chain: string,
		context: (rules: RuleBuilder) => RuleBuilder,
	) => ChainBuilder;
}

export interface TableBuilder {
	forTable: (
		table: string,
		context: (chains: ChainBuilder) => ChainBuilder,
	) => TableBuilder;
	apply: (adaptor: RuleAdaptor) => Promise<void>;
}
/**
 * Returns the default RuleAdaptor which is used to _applyRules_ later on.
 *
 * @export
 * @returns {RuleAdaptor}
 */
export function getDefaultRuleAdaptor(): RuleAdaptor {
	return iptablesRestoreAdaptor;
}

export function convertToRestoreRulesFormat(rules: Rule[]): string {
	const iptablesRestore = ['# iptables-restore -- Balena Firewall'];

	// build rules for each table we have rules for...
	const tables = _(rules)
		.groupBy((rule) => rule.table ?? 'filter')
		.value();

	// for each table, build the rules...
	for (const table of Object.keys(tables)) {
		iptablesRestore.push(`*${table}`);

		// define our chains for this table...
		tables[table]
			.map((rule) => rule.chain)
			.filter((chain, index, self) => {
				if (
					chain === undefined ||
					['INPUT', 'FORWARD', 'OUTPUT'].includes(chain)
				) {
					return false;
				}

				return self.indexOf(chain) === index;
			})
			.forEach((chain) => {
				iptablesRestore.push(`:${chain} - [0:0]`);
			});

		// add the rules...
		tables[table]
			.map((rule) => {
				const args: string[] = [];

				if (rule.action) {
					args.push(rule.action);
				}
				if (rule.chain) {
					args.push(rule.chain);
				}
				if (rule.proto) {
					args.push(`-p ${rule.proto}`);
				}
				if (rule.matches) {
					rule.matches.forEach((match) => args.push(match));
				}
				// TODO: Enable this once the support for it can be confirmed...
				// if (rule.comment) {
				// 	args.push('-m comment');
				// 	args.push(`--comment "${rule.comment}"`);
				// }
				if (rule.target) {
					args.push(`-j ${rule.target}`);
				}

				return args.join(' ');
			})
			.forEach((rule) => iptablesRestore.push(rule));
	}

	// commit the changes...
	iptablesRestore.push('COMMIT');

	// join the rules into a single string...
	iptablesRestore.push('');
	return iptablesRestore.join('\n');
}

/**
 * Applies `iptables` rules, using `iptables-restore`, generated from a collection of Rules.
 *
 * E.g.
 *
 * ```iptables
 * # iptables-restore format
 * *<table>
 * :<chain> <policy> [<packets_count>:<bytes_count>]
 * <optional_counter><rule>
 * ... more rules ...
 * COMMIT
 * ```
 *
 *
 *
 * @param {Rule[]} rules
 */
const iptablesRestoreAdaptor: RuleAdaptor = async (
	rules: Rule[],
): Promise<void> => {
	const rulesFiles = _(rules)
		.groupBy((rule) => `v${rule.family}`)
		.mapValues((ruleset) => convertToRestoreRulesFormat(ruleset))
		.value();

	// run the iptables-restore command...
	for (const family of Object.getOwnPropertyNames(rulesFiles)) {
		if (!['v4', 'v6'].includes(family)) {
			return;
		}

		const ruleset = rulesFiles[family];
		const cmd = family === 'v6' ? 'ip6tables-restore' : 'iptables-restore';
		await new Promise<string>((resolve, reject) => {
			const args = ['--noflush', '--verbose'];

			// prepare to pipe the rules into iptables-restore...
			const stdinStream = new Readable();
			stdinStream.push(ruleset);
			stdinStream.push(null);

			// run the restore...
			const proc = spawn(cmd, args, { shell: true });

			// pipe the rules...
			stdinStream.pipe(proc.stdin);

			// grab any output from the command...
			const stdout: string[] = [];
			proc.stdout?.on('data', (data: Buffer) => {
				stdout.push(data.toString('utf8'));
			});

			const stderr: string[] = [];
			proc.stderr?.on('data', (data: Buffer) => {
				stderr.push(data.toString('utf8'));
			});

			// handle close/error with the promise...
			proc.on('error', (err) => reject(err));
			proc.on('close', (code) => {
				if (code && code !== 0) {
					return reject(
						new IPTablesRuleError(
							`Error running iptables: ${stderr.join()} (${args.join(' ')})`,
							ruleset,
						),
					);
				}
				return resolve(stdout.join());
			});
		});
	}
};

/**
 * Returns a builder structure for creating chains of `iptables` rules.
 *
 * @example
 * ```
 * build()
 *   .forTable('filter', filter => {
 *     filter.forChain('INPUT', chain => {
 *       chain.addRule({...});
 *     })
 *   })
 *   .apply(adaptor);
 * ```
 *
 * @export
 * @returns {TableBuilder}
 */
export function build(): TableBuilder {
	const rules: Rule[] = [];
	const tableBuilder: TableBuilder = {
		forTable: (table, tableCtx) => {
			const chainBuilder: ChainBuilder = {
				forChain: (chain, chainCtx) => {
					const ruleBuilder: RuleBuilder = {
						addRule: (r: Rule) => {
							const newRules = _.castArray(r);
							rules.push(
								...newRules.map((rule) => {
									return {
										...rule,
										...{
											chain,
											table,
										},
									};
								}),
							);
							return ruleBuilder;
						},
					};
					chainCtx(ruleBuilder);
					return chainBuilder;
				},
			};
			tableCtx(chainBuilder);
			return tableBuilder;
		},
		apply: async (adaptor) => {
			await applyRules(rules, adaptor);
		},
	};

	return tableBuilder;
}

/**
 * Applies the Rule(s) using the provided RuleAdaptor. You should always apply rules
 * using this method, rather than directly through an adaptor. This is where any
 * business logic will be done, as opposed to in the adaptor itself.
 *
 * @param {Rule|Rule[]} rules
 * @param {RuleAdaptor} adaptor
 * @returns
 */
async function applyRules(rules: Rule | Rule[], adaptor: RuleAdaptor) {
	const processRule = (rule: Rule, collection: Rule[]) => {
		// apply the rule to IPv6 and IPv4 unless a family is specified...
		if (!rule.family) {
			rule.family = 6;

			// copy the rule, set the family and process as normal...
			processRule(
				{
					...rule,
					...{
						family: 4,
					},
				},
				collection,
			);
		}

		collection.push(rule);
	};

	const processedRules: Rule[] = [];
	_.castArray(rules).forEach((rule) => processRule(rule, processedRules));

	await adaptor(processedRules);
}
