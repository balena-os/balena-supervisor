import { createHash } from 'crypto';

import log from '../lib/supervisor-console';
import * as config from '../config';
import { docker, fetchImageWithProgress } from '../lib/docker-utils';
import { setRebootBreadcrumb } from '../lib/reboot';
import type { ServiceComposeConfig } from './types/service';

const CLASS_LABEL = 'io.balena.image.class';
const STORE_LABEL = 'io.balena.image.store';
const REQUIRES_REBOOT_LABEL = 'io.balena.update.requires-reboot';

/**
 * State of a deployed overlay extension, derived live from the engine.
 * Mirrors the matching `ext_<serviceName>_<shortDigest>` container that
 * `containerNameFor()` produces. The engine is the source of truth — we
 * don't persist this anywhere in the supervisor DB, just reconstruct it
 * each reconcile from `docker.listContainers`.
 */
export interface ExtensionState {
	serviceName: string;
	image: string;
	containerId: string;
}

export interface CompareExtensionsResult {
	/** Target overlays whose (serviceName, digest) pair is not yet tracked. */
	toPull: ServiceComposeConfig[];
	/** Target overlays with an active profile that need a container created. */
	toDeploy: ServiceComposeConfig[];
	/** Containers whose service was dropped from target entirely OR whose
	 * profile is no longer active. Superseded-digest rows are kept —
	 * mobynit decides per-boot whether they're compatible, and the OS-side
	 * `cleanup --stale-os` at HUP commit removes os-stale leftovers. */
	toRemove: ExtensionState[];
}

/**
 * Check if a service is an overlay extension based on its labels.
 */
export function isOverlayService(svc: ServiceComposeConfig): boolean {
	return svc.labels?.[CLASS_LABEL] === 'overlay';
}

/**
 * Check if a service is stored on the data partition.
 * Services without an explicit store label default to 'data'.
 */
export function isDataStore(svc: ServiceComposeConfig): boolean {
	return (
		svc.labels?.[STORE_LABEL] == null || svc.labels[STORE_LABEL] === 'data'
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
	return overlayServices.filter((svc) => isProfileActive(svc, activeProfiles));
}

function isProfileActive(
	svc: ServiceComposeConfig,
	activeProfiles: Set<string>,
): boolean {
	const svcProfiles = svc.profiles ?? [];
	if (svcProfiles.length === 0) {
		return true;
	}
	return svcProfiles.some((p) => activeProfiles.has(p));
}

/**
 * Extract the sha256 digest from an image reference.
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
 * Stable identity key for an image reference. Uses the sha256 digest when
 * present (cross-registry identity), otherwise hashes the image string so
 * local/tagged images still get a deterministic key.
 */
export function imageKey(image: string): string {
	const digest = extractDigest(image);
	if (digest) {
		return digest;
	}
	const h = createHash('sha256').update(image).digest('hex');
	return `sha256:${h}`;
}

function shortDigest(image: string): string {
	return imageKey(image)
		.replace(/^sha256:/, '')
		.slice(0, 12);
}

/**
 * The canonical Docker container name for an overlay. Including the image's
 * short digest means V_old and V_new for the same service can coexist in
 * the engine during a HUP window without colliding on Docker's unique-name
 * constraint. The digest in the name is also the provenance signal that
 * ensureExtensionContainer uses to safely reuse an already-created
 * canonical container after a crashed-mid-deploy.
 */
export function containerNameFor(serviceName: string, image: string): string {
	return `ext_${serviceName}_${shortDigest(image)}`;
}

// Matches names produced by containerNameFor: ext_<serviceName>_<12hex>. The
// serviceName portion may contain underscores, so we anchor on the trailing
// 12-hex shortDigest.
const CONTAINER_NAME_RE = /^\/?ext_(.+)_[0-9a-f]{12}$/;

/**
 * Derive the serviceName from a supervisor-generated canonical container name.
 * Returns undefined if the name doesn't match the pattern (and thus was not
 * produced by containerNameFor).
 */
function serviceNameFromContainerName(name: string): string | undefined {
	const match = CONTAINER_NAME_RE.exec(name);
	return match?.[1];
}

/**
 * Build an ExtensionState array from the live engine — the source of truth.
 * Matches the app-services pattern: no supervisor-side DB for deployed
 * state; we enumerate overlay containers each reconcile and interpret
 * labels + canonical naming to reconstruct identity.
 */
export async function getDeployedExtensions(): Promise<ExtensionState[]> {
	const containers = await docker.listContainers({
		all: true,
		filters: { label: [`${CLASS_LABEL}=overlay`] },
	});
	const rows: ExtensionState[] = [];
	for (const c of containers) {
		const name = c.Names?.[0];
		if (name == null) {
			continue;
		}
		const serviceName = serviceNameFromContainerName(name);
		if (serviceName == null) {
			// Not supervisor-created; skip (e.g. manual CLI deploys with
			// a bare name). The supervisor only manages extensions it
			// deployed under the canonical name.
			continue;
		}
		rows.push({
			serviceName,
			image: c.Image,
			containerId: c.Id,
		});
	}
	return rows;
}

/**
 * Pure diff of wanted overlays (target) against live extension containers
 * with profile awareness. Emits three intents:
 *
 *  - toPull: target overlays whose (serviceName, digest) pair is not yet
 *    in the engine. Profile state is ignored so images for currently-off
 *    profiles are still cached locally — a later profile flip creates a
 *    container without paying for a round-trip pull.
 *  - toDeploy: target overlays with an active profile whose (serviceName,
 *    digest) pair is not yet a live container.
 *  - toRemove: deployed containers whose service was dropped from target
 *    entirely OR whose profile is no longer active. Superseded-digest
 *    containers are kept — mobynit decides per-boot whether both are
 *    compatible, and the OS-side `cleanup --stale-os` at HUP commit
 *    removes os-stale leftovers.
 */
export function compareExtensions(
	current: ExtensionState[],
	target: ServiceComposeConfig[],
	activeProfiles: Set<string> = new Set<string>(),
): CompareExtensionsResult {
	// Current containers keyed on (serviceName, imageKey(image)).
	const currentByPair = new Map<string, ExtensionState>();
	for (const row of current) {
		currentByPair.set(`${row.serviceName}\0${imageKey(row.image)}`, row);
	}

	// Target indexed by serviceName — target has at most one entry per service.
	const targetByService = new Map<string, ServiceComposeConfig>();
	for (const svc of target) {
		targetByService.set(svc.serviceName, svc);
	}

	const toPull: ServiceComposeConfig[] = [];
	const toDeploy: ServiceComposeConfig[] = [];

	for (const svc of target) {
		const targetDigest = imageKey(svc.image);
		const row = currentByPair.get(`${svc.serviceName}\0${targetDigest}`);

		if (row == null) {
			toPull.push(svc);
		}

		if (!isProfileActive(svc, activeProfiles)) {
			continue;
		}
		if (row == null) {
			toDeploy.push(svc);
		}
	}

	const toRemove: ExtensionState[] = [];

	for (const row of current) {
		const targetSvc = targetByService.get(row.serviceName);
		if (targetSvc == null) {
			// Service dropped from target → remove.
			toRemove.push(row);
			continue;
		}
		if (!isProfileActive(targetSvc, activeProfiles)) {
			// Profile inactive → remove; re-activation will create a
			// fresh container (and reuse the local image).
			toRemove.push(row);
		}
		// Else: service in target with active profile. Keep the container,
		// even if its digest differs from the target digest — mobynit's
		// mount-time filter decides compatibility, and os-stale leftovers
		// are handled by `cleanup --stale-os` at HUP commit.
	}

	return { toPull, toDeploy, toRemove };
}

/**
 * Remove every container in toRemove.
 */
export async function removeDroppedExtensions(
	toRemove: ExtensionState[],
): Promise<void> {
	for (const row of toRemove) {
		await removeExtensionContainer(row.containerId);
	}
}

/**
 * Pull an extension image if it is not already local.
 */
export async function ensureExtensionImage(
	image: string,
	abortSignal: AbortSignal,
): Promise<void> {
	try {
		await docker.getImage(image).inspect();
		return;
	} catch {
		// fall through
	}
	log.info(`Pulling extension image: ${image}`);
	const fetchOpts = await config.get('fetchOptions');
	try {
		await fetchImageWithProgress(
			image,
			fetchOpts,
			() => {
				/* progress not tracked for extensions */
			},
			abortSignal,
		);
	} catch (err: any) {
		log.error(`Failed to pull extension image ${image}: ${err.message ?? err}`);
		throw err;
	}
}

/**
 * Create (or adopt) the canonical overlay container for a service.
 * Assumes the image is already local — callers must ensureExtensionImage
 * first. On crashed-mid-deploy, an exited container under the canonical
 * name is reused.
 */
export async function ensureExtensionContainer(
	serviceName: string,
	image: string,
	labels: Record<string, string>,
): Promise<string> {
	const containerName = containerNameFor(serviceName, image);

	try {
		const existing = await docker.getContainer(containerName).inspect();
		if (
			existing.State?.Status === 'dead' ||
			existing.State?.Status === 'removing'
		) {
			try {
				await docker.getContainer(containerName).remove({ force: true });
			} catch (removeErr: any) {
				if (removeErr.statusCode !== 404) {
					log.info(
						`Extension ${serviceName} has dead container with busy mount — skipping deploy until reboot`,
					);
					return existing.Id;
				}
			}
		} else if (existing.State?.Status === 'exited') {
			// Canonical-named, exited: supervisor's own prior deploy that
			// reached Exited(0). Reuse it rather than create a duplicate.
			return existing.Id;
		}
	} catch (err: any) {
		if (err.statusCode !== 404) {
			throw err;
		}
	}

	const container = await docker.createContainer({
		name: containerName,
		Image: image,
		Cmd: ['none'],
		Labels: {
			[CLASS_LABEL]: 'overlay',
			[STORE_LABEL]: labels[STORE_LABEL] ?? 'data',
		},
		HostConfig: {
			Runtime: 'extension',
		},
	});
	await container.start();

	if (labels[REQUIRES_REBOOT_LABEL] === '1') {
		log.info(`Overlay extension ${serviceName} requires reboot`);
		await setRebootBreadcrumb({ extension: serviceName });
	}

	return container.id;
}

/**
 * Remove an extension container (force). 404 is tolerated — the container
 * may already be gone (e.g., via `cleanup --stale-os` at HUP commit, or a
 * prior reconcile pass).
 */
export async function removeExtensionContainer(
	containerId: string,
): Promise<void> {
	try {
		await docker.getContainer(containerId).remove({ force: true });
	} catch (err: any) {
		if (err.statusCode !== 404) {
			throw err;
		}
	}
}

/**
 * Deploy an extension container via Docker API using the extension runtime.
 * Thin wrapper: ensures the image is local then creates the container.
 */
export async function deployExtensionContainer(
	serviceName: string,
	image: string,
	labels: Record<string, string>,
	abortSignal: AbortSignal,
): Promise<string> {
	await ensureExtensionImage(image, abortSignal);
	return ensureExtensionContainer(serviceName, image, labels);
}
