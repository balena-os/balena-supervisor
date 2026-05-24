import { pathOnRoot } from '../lib/host-utils';
import * as fsUtils from '../lib/fs-utils';
import { promises as fs } from 'fs';
import * as logger from '../logging';
import { checkTruthy } from './validation';

// Breadcrumb file on the host /tmp directory that marks the need for a reboot.
// It is set both by host-config changes and by activation reboots for services
// or OS overlay extensions carrying the `io.balena.update.requires-reboot`
// label (see `requiresActivationReboot`). The actual reboot is emitted by the
// device-state apply loop once all other steps have drained.
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

/**
 * Pure predicate for "this activated overlay/service needs a reboot to take
 * effect". True only when the requires-reboot label is set AND the container
 * was created after the current boot (i.e. the reboot has not happened yet).
 */
export function requiresActivationReboot(
	labels: Record<string, string>,
	createdAt: Date | null,
	bootTime: Date,
): boolean {
	return (
		checkTruthy(labels['io.balena.update.requires-reboot']) &&
		createdAt != null &&
		createdAt > bootTime
	);
}
