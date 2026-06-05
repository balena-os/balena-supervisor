import log from '../lib/supervisor-console';
import * as config from '../config';
import {
	docker,
	fetchImageWithProgress,
	getRegistryAndName,
} from '../lib/docker-utils';
import type { ServiceComposeConfig } from './types/service';

const CLASS_LABEL = 'io.balena.image.class';
const STORE_LABEL = 'io.balena.image.store';
const SERVICE_NAME_LABEL = 'io.balena.service-name';

/**
 * State of a deployed overlay extension, derived live from the engine. Only
 * exited-0 containers carrying our service-name label are represented.
 */
export interface ExtensionState {
	serviceName: string;
	image: string;
	containerId: string;
	createdAt: Date;
	labels: Record<string, string>;
}

export interface CompareExtensionsResult {
	/** Target overlays with no current entry of the same serviceName + digest. */
	toDeploy: ServiceComposeConfig[];
	/** Deployed overlays whose service was dropped from target entirely. */
	toDrop: ExtensionState[];
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
 * The sha256 digest of a digest-pinned overlay image. Overlay images are
 * always pinned (`...@sha256:<digest>`); a digest-less ref is a hard error —
 * identity and naming have no meaning without it.
 */
export function digestOf(image: string): string {
	const { digest } = getRegistryAndName(image);
	if (!digest) {
		throw new Error(`Overlay image is not digest-pinned: ${image}`);
	}
	return digest;
}

/**
 * Digest of a pinned ref for identity comparison, or null when the ref carries
 * none (or cannot be parsed).
 */
function digestForCompare(image: string): string | null {
	try {
		return getRegistryAndName(image).digest ?? null;
	} catch {
		return null;
	}
}

function shortDigest(image: string): string {
	return digestOf(image)
		.replace(/^sha256:/, '')
		.slice(0, 12);
}

/**
 * The canonical Docker container name for an overlay.
 */
export function containerNameFor(serviceName: string, image: string): string {
	return `ext_${serviceName}_${shortDigest(image)}`;
}

/**
 * Descriptive name for the named volume backing an image-declared VOLUME at
 * `dest`. Replaces the engine's anonymous 64-hex volume name with
 * `ext_<serviceName>_<shortDigest>_<dest>`, e.g.
 * `ext_kernel-modules_42befc76f4f8_boot`.
 */
export function volumeNameFor(
	serviceName: string,
	image: string,
	dest: string,
): string {
	const sanitizedDest = dest.replace(/^\/+/, '').replace(/\//g, '_');
	return `ext_${serviceName}_${shortDigest(image)}_${sanitizedDest}`;
}

/**
 * Build the deployed-extension list from the live engine. We list overlay
 * containers, inspect each, map to a target service by the service-name label
 * (not by parsing the container name), and report a container as deployed only
 * when it reached the success terminal state: exited, exit code 0, no error.
 * Anything else (created/running/dead/exited-nonzero/error) is treated as
 * absent and will be redeployed.
 */
export async function getDeployedExtensions(): Promise<ExtensionState[]> {
	const containers = await docker.listContainers({
		all: true,
		filters: { label: [`${CLASS_LABEL}=overlay`] },
	});
	const rows: ExtensionState[] = [];
	for (const summary of containers) {
		let info;
		try {
			info = await docker.getContainer(summary.Id).inspect();
		} catch (err: any) {
			// The OS reaper (boot cleanup + HUP `cleanup --stale-os`) removes
			// overlay containers independently, so a container listed above may be
			// gone by the time we inspect it (404). Treat any inspect failure as
			// "absent" and skip it rather than failing the whole apply loop — a
			// transient engine error must not block reconciliation of every app.
			log.debug(
				`Skipping extension container ${summary.Id}: inspect failed: ${
					err.message ?? err
				}`,
			);
			continue;
		}
		const labels = info.Config?.Labels ?? {};
		const serviceName = labels[SERVICE_NAME_LABEL];
		if (serviceName == null) {
			// Not supervisor-deployed (e.g. a manual CLI deploy). Skip.
			continue;
		}
		const state = info.State;
		const deployed =
			state?.Status === 'exited' &&
			state.ExitCode === 0 &&
			(state.Error ?? '') === '';
		if (!deployed) {
			continue;
		}
		rows.push({
			serviceName,
			image: info.Config?.Image ?? '',
			containerId: info.Id,
			createdAt: new Date(info.Created),
			labels,
		});
	}
	return rows;
}

/**
 * Pure diff of target overlays against deployed-good extension containers.
 * Identity is (serviceName, digest).
 *
 *  - toDeploy: target service with no current entry of the same serviceName
 *    AND digest.
 *  - toDrop: current whose serviceName is absent from target.
 *
 * A current overlay whose serviceName is still in target but at a different
 * digest is *kept*, not removed: an applied overlay's mount is in use until
 * reboot, so the supervisor cannot evict it.
 */
export function compareExtensions(
	current: ExtensionState[],
	target: ServiceComposeConfig[],
): CompareExtensionsResult {
	const targetByService = new Map<string, ServiceComposeConfig>();
	for (const svc of target) {
		targetByService.set(svc.serviceName, svc);
	}

	const currentPairs = new Set<string>();
	for (const row of current) {
		const digest = digestForCompare(row.image);
		if (digest == null) {
			// Unidentifiable deployed container: treat as absent so the matching
			// target overlay is re-evaluated, rather than crashing the diff.
			continue;
		}
		currentPairs.add(`${row.serviceName}\0${digest}`);
	}

	const toDeploy: ServiceComposeConfig[] = [];
	for (const svc of target) {
		const digest = digestForCompare(svc.image);
		if (digest == null || !currentPairs.has(`${svc.serviceName}\0${digest}`)) {
			toDeploy.push(svc);
		}
	}

	const toDrop: ExtensionState[] = [];
	for (const row of current) {
		if (!targetByService.has(row.serviceName)) {
			toDrop.push(row);
		}
	}

	return { toDeploy, toDrop };
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

	// Dedicated AbortController for extension pulls. The outer apply-loop
	// signal can still abort us (one-way coupling), but our errors and
	// aborts won't cascade back to the user-app pulls that share the
	// outer signal. Without this isolation, an extension-deployment
	// failure aborts in-flight user-app pulls via the shared abortSignal,
	// which on large user-app images manifests as never-completing pulls
	// (retry cadence == appUpdatePollInterval).
	const innerController = new AbortController();
	const onOuterAbort = () => innerController.abort();
	abortSignal.addEventListener('abort', onOuterAbort);
	try {
		await fetchImageWithProgress(
			image,
			fetchOpts,
			() => {
				/* progress not tracked for extensions */
			},
			innerController.signal,
		);
	} catch (err: any) {
		log.error(`Failed to pull extension image ${image}: ${err.message ?? err}`);
		throw err;
	} finally {
		abortSignal.removeEventListener('abort', onOuterAbort);
	}
}

/**
 * Remove an extension container (force).
 *
 * Two non-failures are tolerated:
 *  - 404: the container is already gone (a prior pass, or the OS-side
 *    `cleanup` already reaped it).
 *  - busy mount: the overlay is still applied and in use by the running
 *    host. It cannot be evicted now and there is nothing to fix.
 */
export async function removeExtensionContainer(
	containerId: string,
): Promise<void> {
	try {
		await docker.getContainer(containerId).remove({ force: true });
	} catch (err: any) {
		if (err.statusCode === 404) {
			return;
		}
		if (isMountBusyError(err)) {
			log.info(
				`Extension container ${containerId} in use, deferring removal until next boot`,
			);
			return;
		}
		throw err;
	}
}

/**
 * True when a force-remove failed because the overlay's mount is still busy
 * (active overlay; freed by reboot + the manager's HUP sweep). Pinned against
 * balenaEngine's actual force-remove error response.
 */
export function isMountBusyError(err: any): boolean {
	const msg = String(err?.message ?? err ?? '');
	return err?.statusCode === 500 && /busy|in use|EBUSY/i.test(msg);
}

/**
 * Deploy the canonical overlay container for a service: ensure the image is
 * local, reconcile any container holding the canonical name, then create +
 * start fresh.
 *
 * A container may already hold the canonical name:
 *  - exited-0 (our own prior good deploy): adopt it, don't recreate.
 *  - dead/partial/failed: clear it so we recreate clean. If clearing fails
 *    because the overlay mount is in use, defer — the active overlay is
 *    reaped on the next boot; return the existing id rather than throw.
 *  - absent (404): normal fresh deploy.
 */
export async function deployExtensionContainer(
	serviceName: string,
	image: string,
	labels: Record<string, string>,
	abortSignal: AbortSignal,
): Promise<string> {
	await ensureExtensionImage(image, abortSignal);
	const name = containerNameFor(serviceName, image);

	try {
		const existing = await docker.getContainer(name).inspect();
		const state = existing.State;
		if (
			state?.Status === 'exited' &&
			state.ExitCode === 0 &&
			(state.Error ?? '') === ''
		) {
			// Our own prior deploy reached Exited(0); adopt rather than recreate.
			return existing.Id;
		}
		try {
			await docker.getContainer(name).remove({ force: true });
		} catch (removeErr: any) {
			if (removeErr.statusCode === 404) {
				// Already gone — fall through to create.
			} else if (isMountBusyError(removeErr)) {
				log.info(
					`Extension ${serviceName} container in use, deferring deploy until next boot`,
				);
				return existing.Id;
			} else {
				throw removeErr;
			}
		}
	} catch (err: any) {
		if (err.statusCode !== 404) {
			throw err;
		}
		// 404: no container holds the name — normal fresh deploy.
	}

	const imageInfo = await docker.getImage(image).inspect();
	const mounts = Object.keys(imageInfo.Config?.Volumes ?? {}).map((dest) => ({
		Type: 'volume' as const,
		Source: volumeNameFor(serviceName, image, dest),
		Target: dest,
	}));

	const container = await docker.createContainer({
		name,
		Image: image,
		Cmd: ['none'],
		Labels: {
			[STORE_LABEL]: 'data', // default; overridden by target labels if set
			...labels,
			[SERVICE_NAME_LABEL]: serviceName,
		},
		HostConfig: {
			Runtime: 'extension',
			// An overlay container runs its hooks and exits 0; it is never a
			// long-lived process and has no reason to join a network.
			NetworkMode: 'none',
			Mounts: mounts,
		},
	});

	try {
		await container.start();
	} catch (err: any) {
		// Tolerate 304 (already started), mirroring service-manager.
		if (err.statusCode !== 304) {
			throw err;
		}
	}

	return container.id;
}
