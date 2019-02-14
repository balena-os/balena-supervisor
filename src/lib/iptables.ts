import * as Bluebird from 'bluebird';
import * as childProcess from 'child_process';

// The following is exported so that we stub it in the tests
export const execAsync: (args: string) => Bluebird<string> = Bluebird.promisify(
	childProcess.exec,
);

function applyIptablesArgs(args: string): Bluebird<void> {
	return Bluebird.all([
		execAsync(`iptables ${args}`),
		execAsync(`ip6tables ${args}`),
	]).return();
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
	return (
		Bluebird.each(allowedInterfaces, iface =>
			clearAndInsertIptablesRule(
				`INPUT -p tcp --dport ${port} -i ${iface} -j ACCEPT`,
			),
		)
			.then(() =>
				clearAndAppendIptablesRule(`INPUT -p tcp --dport ${port} -j REJECT`),
			)
			// On systems without REJECT support, fall back to DROP
			.catch(() =>
				clearAndAppendIptablesRule(`INPUT -p tcp --dport ${port} -j DROP`),
			)
	);
}

export function removeRejections(port: number): Bluebird<void> {
	return clearIptablesRule(`INPUT -p tcp --dport ${port} -j REJECT`)
		.catchReturn(null)
		.then(() => clearIptablesRule(`INPUT -p tcp --dport ${port} -j DROP`))
		.catchReturn(null)
		.return();
}
