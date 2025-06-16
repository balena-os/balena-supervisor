import log from '../lib/supervisor-console';
import { exec } from '../lib/fs-utils';
import { pathExistsOnRoot } from '../lib/host-utils';
import { setTimeout } from 'timers';
import { reboot } from '../lib/dbus';

/** Runs an OS update via the proxy action server script, upgrade-2.x.sh. */

// const scriptPath = pathOnRoot('/tmp/balena-supervisor/upgrade-2.x.sh');
const scriptPath = '/mnt/data/balenahup/upgrade-2.x.sh';

/**
 * Run OS upgrade; assumes upgrade script already present. Logs process output.
 *
 * Parameters:
 *   osVersion -- like 6.1.44, excluding the 'v' prefix
 *
 * Reboots on success, otherwise logs the exit code from the upgrade script
 */
export async function runUpgrade(osVersion: string) {
	try {
		if (!pathExistsOnRoot(scriptPath)) {
			throw new Error("Can't find upgrade script");
		}
		log.info(`Starting OS upgrade to ${osVersion}`);
		// See https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
		// M            -- Running within a VM
		// service-type -- Wait for new process to exec to indicate it has started
		// wait         -- Wait for upgrade script to terminate
		// Throws Error with code if process has non-zero exit code
		const res = await exec(
			`systemd-run -M .host --service-type=exec --wait ${scriptPath} --hostos-version ${osVersion} --balenaos-registry registry2.balena-cloud.com --no-reboot`,
		);
		log.info(`OS upgrade to ${osVersion}; result ${JSON.stringify(res)}`);
		await reboot();
	} catch (e) {
		log.error("Can't run upgrade! ", e);
	}
}

export function schedule(osVersion: string) {
	setTimeout(runUpgrade, 90 * 1000, osVersion);
}
