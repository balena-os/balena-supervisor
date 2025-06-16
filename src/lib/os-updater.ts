import log from '../lib/supervisor-console';
import { exec, exists } from '../lib/fs-utils';
import { pathOnData } from '../lib/host-utils';
// import { setRebootBreadcrumb } from '../lib/reboot';

/** Runs an OS update via the proxy action server script, upgrade-2.x.sh. */

// const scriptPath = pathOnRoot('/tmp/balena-supervisor/upgrade-2.x.sh');
const scriptPath = 'balenahup/upgrade-2.x.sh';

// State of upgrade
let runState = 'none';

/** Returns true if upgrade is in progress. */
export function isRunning() {
	return runState === 'running';
}

/**
 * Run OS upgrade; assumes upgrade script already present. Logs process output.
 * Aborts if upgrade already running. Sets reboot breadcrumb on success.
 *
 * Parameters:
 *   osVersion -- like 6.1.44, excluding the 'v' prefix
 *
 * Reboots on success, otherwise logs the exit code from the upgrade script
 */
export async function runUpgrade(osVersion: string) {
	// 2025-07-26 For simplicity, does not update runState when complete or
	// failed -- leaves the state as always running.
	// This is wrong, but we are hacking. Our goal was to stop attempting to
	// run the update when already running -- and this approach is effective.
	// Next we need to expand handling to these other states.
	try {
		if (runState === 'running') {
			log.debug('OS updater already running');
			return;
		} else {
			runState = 'running';
		}
		if (!(await exists(pathOnData(scriptPath)))) {
			throw new Error("Can't find upgrade script");
		}

		log.info(`Starting OS upgrade to ${osVersion}`);
		// See https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
		// M            -- Running within a VM
		// service-type -- Wait for new process to exec to indicate it has started
		// wait         -- Wait for upgrade script to terminate
		// Throws Error with code if process has non-zero exit code
		const res = await exec(
			`systemd-run -M .host --service-type=exec --wait ${pathOnData(scriptPath)} --hostos-version ${osVersion} --balenaos-registry registry2.balena-cloud.com --no-reboot`,
		);
		// runState = 'completed';
		log.info(`OS upgrade to ${osVersion}; result ${JSON.stringify(res)}`);
		// Doesn't work due to update lock.
		// await setRebootBreadcrumb({ hostApp: 'os-updater' });
	} catch (e) {
		// runState = 'failed';
		log.error("Can't run upgrade! ", e);
	}
}
