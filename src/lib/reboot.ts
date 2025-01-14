import { pathOnRoot } from '../lib/host-utils';
import * as fsUtils from '../lib/fs-utils';
import { promises as fs } from 'fs';
import * as logger from '../logging';

// This indicates the file on the host /tmp directory that
// marks the need for a reboot. Since reboot is only triggered for now
// by some config changes, we leave this here for now. There is planned
// functionality to allow image installs to require reboots, at that moment
// this constant can be moved somewhere else
const REBOOT_BREADCRUMB = pathOnRoot(
	'/tmp/balena-supervisor/reboot-after-apply',
);

export async function setRebootBreadcrumb(source: Dictionary<any> = {}) {
	// Just create the file. The last step in the target state calculation will check
	// the file and create a reboot step
	await fsUtils.touch(REBOOT_BREADCRUMB);
	logger.logSystemMessage(
		`Reboot has been scheduled to apply changes: ${JSON.stringify(source)}`,
		{},
		'Reboot scheduled',
	);
}

export async function isRebootBreadcrumbSet() {
	return await fsUtils.exists(REBOOT_BREADCRUMB);
}

export async function isRebootRequired() {
	const hasBreadcrumb = await fsUtils.exists(REBOOT_BREADCRUMB);
	if (hasBreadcrumb) {
		const stats = await fs.stat(REBOOT_BREADCRUMB);

		// If the breadcrumb exists and the last modified time is greater than the
		// boot time, that means we need to reboot
		return stats.mtime.getTime() > fsUtils.getBootTime().getTime();
	}
	return false;
}
