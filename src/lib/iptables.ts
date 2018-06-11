import * as Promise from 'bluebird';
import * as childProcess from 'child_process';

// The following is exported so that we stub it in the tests
export const execAsync = Promise.promisify(childProcess.exec);

function clearAndAppendIptablesRule(rule: string): Promise<void> {
	return execAsync(`iptables -D ${rule}`)
		.catchReturn(null)
		.then(() => execAsync(`iptables -A ${rule}`))
		.return();
}

function clearAndInsertIptablesRule(rule: string): Promise<void> {
	return execAsync(`iptables -D ${rule}`)
		.catchReturn(null)
		.then(() => execAsync(`iptables -I ${rule}`))
		.return();
}

export function rejectOnAllInterfacesExcept(
	allowedInterfaces: string[],
	port: number,
): Promise<void> {
	// We delete each rule and create it again to ensure ordering (all ACCEPTs before the REJECT/DROP).
	// This is especially important after a supervisor update.
	return Promise.each(allowedInterfaces, (iface) => clearAndInsertIptablesRule(`INPUT -p tcp --dport ${port} -i ${iface} -j ACCEPT`))
		.then(() => clearAndAppendIptablesRule(`INPUT -p tcp --dport ${port} -j REJECT`))
		// On systems without REJECT support, fall back to DROP
		.catch(() => clearAndAppendIptablesRule(`INPUT -p tcp --dport ${port} -j DROP`))
		.return();
}
