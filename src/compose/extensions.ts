import log from '../lib/supervisor-console';
import * as dbus from '../lib/dbus';
import * as config from '../config';
import { setRebootBreadcrumb } from '../lib/reboot';
import type { ServiceComposeConfig } from './types/service';

/**
 * State of a deployed overlay extension tracked in the supervisor.
 * This is used to detect changes and avoid unnecessary redeployments.
 */
export interface ExtensionState {
	serviceName: string;
	image: string;
	imageDigest?: string;
	profile?: string;
	deployedAt: string;
}

/**
 * Result of deploying overlay extensions.
 */
export interface ExtensionDeployResult {
	/** Whether any extension requires a reboot after deployment */
	needsReboot: boolean;
	/** Extensions that were successfully deployed */
	deployed: string[];
	/** Extensions that were removed */
	removed: string[];
	/** Error message if deployment failed */
	error?: string;
}

/**
 * Check if a service is an overlay extension based on its labels.
 */
export function isOverlayService(svc: ServiceComposeConfig): boolean {
	return svc.labels?.['io.balena.image.class'] === 'overlay';
}

/**
 * Check if a service is stored on the data partition.
 * Services without an explicit store label default to 'data'.
 */
export function isDataStore(svc: ServiceComposeConfig): boolean {
	return (
		svc.labels?.['io.balena.image.store'] == null ||
		svc.labels['io.balena.image.store'] === 'data'
	);
}

/**
 * Filter overlay services by active profiles.
 * Services without profiles are always included (backward compatible).
 * Services with profiles need at least one matching active profile.
 */
export function filterByActiveProfiles(
	overlayServices: ServiceComposeConfig[],
	activeProfiles: Set<string>,
): ServiceComposeConfig[] {
	return overlayServices.filter((svc) => {
		const svcProfiles = svc.profiles ?? [];
		if (svcProfiles.length === 0) {
			// No profiles means always deploy
			return true;
		}
		return svcProfiles.some((p) => activeProfiles.has(p));
	});
}

/**
 * Extract the digest from an image reference.
 * e.g., "registry.com/v2/abc@sha256:15ba80..." → "sha256:15ba80..."
 * Returns undefined if no digest is present.
 */
export function extractDigest(image: string): string | undefined {
	const idx = image.lastIndexOf('@sha256:');
	if (idx >= 0) {
		return image.slice(idx + 1);
	}
	return undefined;
}

/**
 * Check if two image references point to the same content.
 * Compares by digest when both have one, falls back to full string.
 */
function isSameImage(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const digestA = extractDigest(a);
	const digestB = extractDigest(b);
	if (digestA && digestB) {
		return digestA === digestB;
	}
	return false;
}

/**
 * Compare current deployed extensions with target extensions to determine
 * what needs to be added, removed, or updated.
 */
export function compareExtensions(
	current: ExtensionState[],
	target: ServiceComposeConfig[],
): {
	toAdd: ServiceComposeConfig[];
	toRemove: ExtensionState[];
	toUpdate: ServiceComposeConfig[];
} {
	const currentByName: Record<string, ExtensionState> = {};
	for (const ext of current) {
		currentByName[ext.serviceName] = ext;
	}

	const targetByName: Record<string, ServiceComposeConfig> = {};
	for (const svc of target) {
		targetByName[svc.serviceName] = svc;
	}

	const toAdd: ServiceComposeConfig[] = [];
	const toRemove: ExtensionState[] = [];
	const toUpdate: ServiceComposeConfig[] = [];

	// Find extensions to add or update
	for (const name of Object.keys(targetByName)) {
		const svc = targetByName[name];
		const curr = currentByName[name];
		if (!curr) {
			toAdd.push(svc);
		} else if (!isSameImage(curr.image, svc.image)) {
			// Image changed - needs update
			toUpdate.push(svc);
		}
		// If image is same (by digest or full string), no action needed
	}

	// Find extensions to remove
	for (const name of Object.keys(currentByName)) {
		if (!targetByName[name]) {
			toRemove.push(currentByName[name]);
		}
	}

	return { toAdd, toRemove, toUpdate };
}

/**
 * Handle deployment of overlay extensions from the hostapp release.
 *
 * This function:
 * 1. Filters overlay services by active profiles
 * 2. Compares with currently deployed extensions
 * 3. Calls update-hostapp-extensions to deploy/remove extensions
 * 4. Returns whether a reboot is required
 *
 * @param overlayServices - All overlay services from the hostapp release
 * @param activeProfiles - Set of active profiles (from device config + contracts)
 * @param currentExtensions - Currently deployed extensions (from DB)
 * @returns Result indicating whether reboot is needed and what was deployed/removed
 */
export async function handleOverlayExtensions(
	overlayServices: ServiceComposeConfig[],
	activeProfiles: Set<string>,
	currentExtensions: ExtensionState[] = [],
): Promise<ExtensionDeployResult> {
	// Filter by active profiles
	const matchingExtensions = filterByActiveProfiles(
		overlayServices,
		activeProfiles,
	);

	// Log profile filtering
	const filtered = overlayServices.filter(
		(svc) => !matchingExtensions.some((m) => m.serviceName === svc.serviceName),
	);
	if (filtered.length > 0) {
		log.info(
			`Overlay extensions filtered by inactive profiles: ${filtered.map((s) => s.serviceName).join(', ')}`,
		);
	}

	// Compare with current state
	const { toAdd, toRemove, toUpdate } = compareExtensions(
		currentExtensions,
		matchingExtensions,
	);

	// If nothing changed, return early
	if (toAdd.length === 0 && toRemove.length === 0 && toUpdate.length === 0) {
		log.debug('No overlay extension changes needed');
		return { needsReboot: false, deployed: [], removed: [] };
	}

	// Build the target image list for update-hostapp-extensions
	const targetImages = matchingExtensions.map((svc) => svc.image);

	log.info(
		`Deploying overlay extensions: ${matchingExtensions.map((s) => s.serviceName).join(', ')}`,
	);
	if (toRemove.length > 0) {
		log.info(
			`Removing overlay extensions: ${toRemove.map((e) => e.serviceName).join(', ')}`,
		);
	}

	// Write target image list to config.json for the host service to read.
	// balena-config-vars maps hostappExtensions → HOSTEXT_IMAGES env var.
	// Restart the host's update-hostapp-extensions.service via D-Bus and
	// wait for the oneshot to complete.
	try {
		await config.set({
			hostappExtensions: targetImages.join(' ') || null,
		});
		await dbus.restartService('update-hostapp-extensions');
		const finalState = await dbus.waitForServiceState(
			'update-hostapp-extensions',
			['active', 'failed', 'inactive'],
		);
		if (finalState === 'failed') {
			throw new Error('update-hostapp-extensions.service failed');
		}
	} catch (err) {
		const errorMsg = `Failed to deploy overlay extensions: ${err}`;
		log.error(errorMsg);
		// Don't throw - allow user apps to continue even if extensions fail
		// The extensions may be partially deployed
		return {
			needsReboot: false,
			deployed: [],
			removed: [],
			error: errorMsg,
		};
	}

	// Check if any newly deployed or updated extension requires reboot
	const changedExtensions = [...toAdd, ...toUpdate];
	const needsReboot = changedExtensions.some(
		(svc) => svc.labels?.['io.balena.image.requires-reboot'] === '1',
	);

	if (needsReboot) {
		log.info('Overlay extension requires reboot');
		// Set the reboot breadcrumb so the device state module knows to reboot
		await setRebootBreadcrumb({
			extensions: changedExtensions.map((s) => s.serviceName),
		});
	}

	return {
		needsReboot,
		deployed: changedExtensions.map((s) => s.serviceName),
		removed: toRemove.map((e) => e.serviceName),
	};
}
