import log from '../lib/supervisor-console';
import * as apiHelper from '../lib/api-helper';
import * as constants from '../lib/constants';
import { getOSBoardRev, getOSSemver } from '../lib/os-release';
import { isRunning as isUpdaterRunning } from '../lib/os-updater';
import type { InstancedDeviceState } from './target-state';
import type { App, CompositionStep } from '../compose/types';

/**
 * Represents the host/OS aspects for management of device state.
 */

/**
 * Adds a step to upgrade OS if OS version changed in target state. Current OS
 * version must be >= v6.1 or a step never will be added.
 */
export async function getRequiredSteps(
	targetState: InstancedDeviceState,
): Promise<CompositionStep[]> {
	const steps: CompositionStep[] = [];
	const apps = targetState.local?.hostApps ?? {};
	for (const app of Object.values(apps)) {
		if (app.isHost) {
			await addSteps(steps, app);
		}
	}
	return steps;
}

/**
 * Adds upgrade step if board revision differs in target hostapp. Since board
 * revision is defined only for OS >= v6.1, can't compare if target precedes
 * that version. Also validates an update is not running already.
 *
 * Addition of the OS upgrade step does not specifically require a version *increase*,
 * only a change. Assumes that the caller manages the semantics for acceptance
 * of a particular version.
 */
async function addSteps(steps: CompositionStep[], hostApp: App) {
	// Compare current/target board-rev; if equal, must be same OS version
	let targetBoardRev = '';
	if (hostApp.services.length > 0) {
		// assumes a single hostapp
		targetBoardRev =
			hostApp.services[0].config.labels[
				'io.balena.private.hostapp.board-rev'
			] ?? '';
	}
	const currentBoardRev =
		(await getOSBoardRev(constants.hostOSVersionPath)) ?? '';
	if (
		currentBoardRev === '' ||
		targetBoardRev === '' ||
		targetBoardRev === currentBoardRev
	) {
		log.debug('Board revision undefined or unchanged');
		return;
	}

	if (isUpdaterRunning()) {
		log.info('Updater running; not adding step');
		return;
	}

	// Retrieve target semver via API release resource.
	const balenaApi = await apiHelper.getBalenaApi();
	const reqOpts = {
		resource: 'release',
		options: {
			$filter: {
				commit: hostApp.commit,
			},
			$select: 'semver',
		},
	};
	const releases = (await balenaApi.get(reqOpts)) ?? [];
	if (releases.length === 0) {
		log.warn(`No releases found for target commit ${hostApp.commit}`);
		return;
	}
	const targetSemver = releases[0].semver ?? '';
	if (targetSemver.length === 0) {
		log.warn("Can't read semver for target release");
		return;
	}

	// Read current semver from /etc/os-release.
	const currentOsVersion =
		(await getOSSemver(constants.hostOSVersionPath)) ?? '';
	if (currentOsVersion.length === 0) {
		log.warn("Can't read current OS version from host");
		return;
	}

	if (targetSemver !== currentOsVersion) {
		steps.push({ action: 'runOsUpdater', osVersion: targetSemver });
		log.info(`Pushed runOsUpdater for version ${targetSemver}`);
	}
}
