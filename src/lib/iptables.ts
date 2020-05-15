import * as Bluebird from 'bluebird';
import * as childProcess from 'child_process';

// The following is exported so that we stub it in the tests
export const execAsync: (args: string) => Bluebird<string> = Bluebird.promisify(
	childProcess.exec,
);

function applyIptablesArgs(args: string): Bluebird<void> {
	let err: Error | null = null;
	// We want to run both commands regardless, but also rethrow an error
	// if one of them fails
	return execAsync(`iptables ${args}`)
		.catch((e) => (err = e))
		.then(() => execAsync(`ip6tables ${args}`).catch((e) => (err = e)))
		.then(() => {
			if (err != null) {
				throw err;
			}
		});
}

function clearIptablesRule(rule: string): Bluebird<void> {
	return applyIptablesArgs(`-D ${rule}`);
}

function clearAndAppendIptablesRule(rule: string): Bluebird<void> {
	return clearIptablesRule(rule)
		.catchReturn(null)
		.then(() => applyIptablesArgs(`-A ${rule}`));
}

function clearAndInsertIptablesRule(rule: string): Bluebird<void> {
	return clearIptablesRule(rule)
		.catchReturn(null)
		.then(() => applyIptablesArgs(`-I ${rule}`));
}

export function rejectOnAllInterfacesExcept(
	allowedInterfaces: string[],
	port: number,
): Bluebird<void> {
	// We delete each rule and create it again to ensure ordering (all ACCEPTs before the REJECT/DROP).
	// This is especially important after a supervisor update.
	return Bluebird.each(allowedInterfaces, (iface) =>
		clearAndInsertIptablesRule(
			`INPUT -p tcp --dport ${port} -i ${iface} -j ACCEPT`,
		),
	)
		.then(() =>
			clearAndAppendIptablesRule(
				`OUTPUT -p tcp --sport ${port} -m state --state ESTABLISHED -j ACCEPT`,
			),
		)
		.then(() =>
			clearAndAppendIptablesRule(`INPUT -p tcp --dport ${port} -j REJECT`),
		);
}

export function removeRejections(port: number): Bluebird<void> {
	return clearIptablesRule(`INPUT -p tcp --dport ${port} -j REJECT`)
		.catchReturn(null)
		.then(() => clearIptablesRule(`INPUT -p tcp --dport ${port} -j DROP`))
		.catchReturn(null)
		.return();
}
