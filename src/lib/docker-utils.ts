import { DockerProgress } from 'docker-progress';
import type { ProgressCallback, PullPushOptions } from 'docker-progress';
import Dockerode from 'dockerode';
import _ from 'lodash';
import memoizee from 'memoizee';
import { applyDelta, OutOfSyncError } from 'docker-delta';

import log from './supervisor-console';
import { envArrayToObject } from './conversions';
import * as request from './request';
import {
	DeltaStillProcessingError,
	ImageAuthenticationError,
	InvalidNetGatewayError,
	DeltaServerError,
	DeltaApplyError,
	isStatusError,
} from './errors';
import type { EnvVarObject } from '../types';
import type { SchemaReturn } from '../config/schema-type';

export type FetchOptions = SchemaReturn<'fetchOptions'>;
export type DeltaFetchOptions = FetchOptions & {
	deltaSourceId: string;
	deltaSource: string;
};

interface RsyncApplyOptions {
	timeout: number;
	maxRetries: number;
	retryInterval: number;
}

type ImageNameParts = {
	registry?: string;
	imageName: string;
	tagName?: string;
	digest?: string;
};

// How long do we keep a delta token before invalidating it
// (10 mins)
const DELTA_TOKEN_TIMEOUT = 10 * 60 * 1000;

// How many times to retry a v3 delta apply before falling back to a regular pull.
// A delta is applied to the base image when pulling, so a failure could be due to
// "layers from manifest don't match image configuration", which can occur before
// or after downloading delta image layers.
//
// Other causes of failure have not been documented as clearly as "layers from manifest"
// but could manifest as well, though unclear if they occur before, after, or during
// downloading delta image layers.
//
// See: https://github.com/balena-os/balena-engine/blob/master/distribution/pull_v2.go#L43
const DELTA_APPLY_RETRY_COUNT = 3;

export const docker = new Dockerode();
export const dockerProgress = new DockerProgress({
	docker,
});

// Separate string containing registry and image name into its parts.
// Example: registry2.balena.io/balena/rpi
//          { registry: "registry2.balena.io", imageName: "balena/rpi" }
// Moved here from
// https://github.com/balena-io-modules/docker-toolbelt/blob/master/lib/docker-toolbelt.coffee#L338
export function getRegistryAndName(uri: string): ImageNameParts {
	// https://github.com/docker/distribution/blob/release/2.7/reference/normalize.go#L62
	// https://github.com/docker/distribution/blob/release/2.7/reference/regexp.go#L44
	const imageComponents = uri.match(
		/^(?:(localhost|.*?[.:].*?)\/)?(.+?)(?::(.*?))?(?:@(.*?))?$/,
	);

	if (!imageComponents) {
		throw new Error(`Could not parse the image: ${uri}`);
	}

	const [, registry, imageName, tag, digest] = imageComponents;
	const tagName = !digest && !tag ? 'latest' : tag;
	const digestMatch = digest?.match(
		/^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-f-A-F]{32,}$/,
	);
	if (!imageName || (digest && !digestMatch)) {
		throw new Error(
			`Invalid image name, expected [domain.tld/]repo/image[:tag][@digest] format, got: ${uri}`,
		);
	}

	return { registry, imageName, tagName, digest };
}

// Normalise an image name to always have a tag, with :latest being the default
export function normaliseImageName(image: string) {
	const { registry, imageName, tagName, digest } = getRegistryAndName(image);
	const repository = [registry, imageName].filter((s) => !!s).join('/');

	if (!digest) {
		return [repository, tagName ?? 'latest'].join(':');
	}

	// Intentionally discard the tag when a digest exists
	return [repository, digest].join('@');
}

export function getRepoAndTag(image: string): { repo: string; tag?: string } {
	const { registry, imageName, tagName } = getRegistryAndName(image);

	let repoName = imageName;

	if (registry != null) {
		repoName = `${registry}/${imageName}`;
	}

	return { repo: repoName, tag: tagName };
}

// Same as getRepoAndTag but joined with ':' for searching
export function getImageWithTag(image: string) {
	const { repo, tag } = getRepoAndTag(image);

	return [repo, tag ?? 'latest'].join(':');
}

export async function fetchDeltaWithProgress(
	imgDest: string,
	deltaOpts: DeltaFetchOptions,
	onProgress: ProgressCallback,
	serviceName: string,
	abortSignal: AbortSignal,
): Promise<string> {
	const deltaSourceId = deltaOpts.deltaSourceId ?? deltaOpts.deltaSource;
	const timeout = deltaOpts.deltaApplyTimeout;

	const logFn = (str: string) => {
		log.debug(`delta([${serviceName}] ${deltaOpts.deltaSource}): ${str}`);
	};

	if (![2, 3].includes(deltaOpts.deltaVersion)) {
		logFn(
			`Unsupported delta version: ${deltaOpts.deltaVersion}. Falling back to regular pull`,
		);
		return await fetchImageWithProgress(
			imgDest,
			deltaOpts,
			onProgress,
			abortSignal,
		);
	}

	// We need to make sure that we're not trying to apply a
	// v3 delta on top of a v2 delta, as this will cause the
	// update to fail, and we must fall back to a standard
	// image pull
	if (
		deltaOpts.deltaVersion === 3 &&
		(await isV2DeltaImage(deltaOpts.deltaSourceId))
	) {
		logFn(`Cannot create a delta from V2 to V3, falling back to regular pull`);
		return await fetchImageWithProgress(
			imgDest,
			deltaOpts,
			onProgress,
			abortSignal,
		);
	}

	// Since the supevisor never calls this function with a source anymore,
	// this should never happen, but we handle it anyway
	if (deltaOpts.deltaSource == null) {
		logFn('Falling back to regular pull due to lack of a delta source');
		return fetchImageWithProgress(imgDest, deltaOpts, onProgress, abortSignal);
	}

	logFn(`Starting delta to ${imgDest}`);

	const [dstInfo, srcInfo] = [
		getRegistryAndName(imgDest),
		getRegistryAndName(deltaOpts.deltaSource),
	];

	const token = await getAuthToken(srcInfo, dstInfo, deltaOpts);

	const opts: request.requestLib.CoreOptions = {
		followRedirect: false,
		timeout: deltaOpts.deltaRequestTimeout,
		auth: {
			bearer: token,
			sendImmediately: true,
		},
	};

	const url = `${deltaOpts.deltaEndpoint}/api/v${deltaOpts.deltaVersion}/delta?src=${deltaOpts.deltaSource}&dest=${imgDest}`;

	const [res, data] = await (
		await request.getRequestInstance()
	).getAsync(url, opts);
	if (res.statusCode === 502 || res.statusCode === 504) {
		throw new DeltaStillProcessingError();
	}
	let id: string | undefined;
	try {
		switch (deltaOpts.deltaVersion) {
			case 2:
				if (
					!(
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers['location'] != null
					)
				) {
					throw new Error(
						`Got ${res.statusCode} when requesting an image from delta server.`,
					);
				}
				{
					// lexical declarations inside a case clause need to be wrapped in a block
					const deltaUrl = res.headers['location'];
					const deltaSrc = deltaSourceId;
					const resumeOpts = {
						timeout: deltaOpts.deltaRequestTimeout,
						maxRetries: deltaOpts.deltaRetryCount,
						retryInterval: deltaOpts.deltaRetryInterval,
					};
					id = await applyRsyncDelta(
						deltaSrc,
						deltaUrl,
						timeout,
						resumeOpts,
						onProgress,
						logFn,
					);
				}
				break;
			case 3:
				// If 400s status code, throw a more specific error & revert immediately to a regular pull,
				// unless the code is 401 Unauthorized, in which case we should surface the error by retrying
				// the delta server request, instead of falling back to a regular pull immediately.
				if (res.statusCode >= 400 && res.statusCode < 500) {
					if (res.statusCode === 401) {
						throw new Error(
							`Got ${res.statusCode} when requesting an image from delta server: ${res.statusMessage}`,
						);
					} else {
						throw new DeltaServerError(res.statusCode, res.statusMessage);
					}
				}
				if (res.statusCode !== 200) {
					throw new Error(
						`Got ${res.statusCode} when requesting v3 delta from delta server.`,
					);
				}
				{
					// lexical declarations inside a case clause need to be wrapped in a block
					let name;
					try {
						name = JSON.parse(data).name;
					} catch (e) {
						throw new Error(
							`Got an error when parsing delta server response for v3 delta: ${e}`,
						);
					}
					// Try to apply delta DELTA_APPLY_RETRY_COUNT times, then throw DeltaApplyError
					let lastError: Error | undefined = undefined;
					for (
						let tryCount = 0;
						tryCount < DELTA_APPLY_RETRY_COUNT;
						tryCount++
					) {
						try {
							id = await applyBalenaDelta(
								name,
								token,
								onProgress,
								logFn,
								abortSignal,
							);
							break;
						} catch (e) {
							if (isStatusError(e) || abortSignal.aborted) {
								// A status error during delta pull indicates network issues,
								// so we should throw an error to the handler that indicates that
								// the delta pull should be retried until network issues are resolved,
								// rather than falling back to a regular pull.
								//
								// Also don't retry if the operation was intentionally aborted
								throw e;
							}
							lastError = e as Error;
							logFn(
								`Delta apply failed, retrying (${tryCount + 1}/${DELTA_APPLY_RETRY_COUNT})...`,
							);
						}
					}
					if (lastError) {
						throw new DeltaApplyError(lastError.message);
					}
				}
				break;
			default:
				throw new Error(`Unsupported delta version: ${deltaOpts.deltaVersion}`);
		}
	} catch (e) {
		// Log appropriate message based on error type
		if (e instanceof OutOfSyncError) {
			logFn('Falling back to regular pull due to delta out of sync error');
		} else if (e instanceof DeltaServerError) {
			logFn(
				`Falling back to regular pull due to delta server error (${e.statusCode})${e.statusMessage ? `: ${e.statusMessage}` : ''}`,
			);
		} else if (e instanceof DeltaApplyError) {
			// A delta apply error is raised from the Engine and doesn't have a status code
			logFn(
				`Falling back to regular pull due to delta apply error ${e.message ? `: ${e.message}` : ''}`,
			);
		} else {
			logFn(`Delta failed with ${e}`);
			throw e;
		}

		// For handled errors, fall back to regular pull
		return fetchImageWithProgress(imgDest, deltaOpts, onProgress, abortSignal);
	}

	logFn(`Delta applied successfully`);
	// id should always be assigned in all cases unless an error is thrown,
	// but TypeScript complains unless we explicitly confirm id is assigned
	if (!id) {
		throw new Error('Failed to get image ID after delta apply');
	}
	return id;
}

export async function fetchImageWithProgress(
	image: string,
	{ uuid, currentApiKey }: FetchOptions,
	onProgress: ProgressCallback,
	abortSignal: AbortSignal,
): Promise<string> {
	const { registry } = getRegistryAndName(image);

	const dockerOpts =
		// If no registry is specified, we assume the image is a public
		// image on the default engine registry, and we don't need to pass any auth
		registry != null
			? {
					authconfig: {
						username: `d_${uuid}`,
						password: currentApiKey,
						serverAddress: registry,
					},
					abortSignal,
				}
			: { abortSignal };

	await dockerProgress.pull(image, onProgress, dockerOpts);
	return (await docker.getImage(image).inspect()).Id;
}

export async function getImageEnv(id: string): Promise<EnvVarObject> {
	const inspect = await docker.getImage(id).inspect();

	try {
		return envArrayToObject(_.get(inspect, ['Config', 'Env'], []));
	} catch (e) {
		log.error('Error getting env from image', e);
		return {};
	}
}

export async function getNetworkGateway(networkName: string): Promise<string> {
	if (networkName === 'host') {
		return '127.0.0.1';
	}

	const network = await docker.getNetwork(networkName).inspect();
	const config = _.get(network, ['IPAM', 'Config', '0']);
	if (config != null) {
		if (config.Gateway != null) {
			return config.Gateway;
		}
		if (config.Subnet != null && _.endsWith(config.Subnet, '.0/16')) {
			return config.Subnet.replace('.0/16', '.1');
		}
	}
	throw new InvalidNetGatewayError(
		`Cannot determine network gateway for ${networkName}`,
	);
}

async function applyRsyncDelta(
	imgSrc: string,
	deltaUrl: string,
	applyTimeout: number,
	opts: RsyncApplyOptions,
	onProgress: ProgressCallback,
	logFn: (str: string) => void,
): Promise<string> {
	logFn(`Applying rsync delta: ${deltaUrl}`);

	const resumable = await request.getResumableRequest();
	return new Promise((resolve, reject) => {
		const req = resumable(Object.assign({ url: deltaUrl }, opts));
		req
			.on('progress', onProgress)
			.on('retry', onProgress)
			.on('error', reject)
			.on('response', (res) => {
				if (res.statusCode !== 200) {
					reject(
						new Error(
							`Got ${res.statusCode} when requesting delta from storage.`,
						),
					);
					// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
				} else if (parseInt(res.headers['content-length'] || '0', 10) === 0) {
					reject(new Error('Invalid delta URL'));
				} else {
					const deltaStream = applyDelta(docker, imgSrc, {
						log: logFn,
						timeout: applyTimeout,
					});
					res
						.pipe(deltaStream)
						.on('id', (id) => {
							resolve(`sha256:${id}`);
						})
						.on('error', (err) => {
							logFn(`Delta stream emitted error: ${err}`);
							req.abort();
							reject(err);
						});
				}
			});
	});
}

async function applyBalenaDelta(
	deltaImg: string,
	token: string | null,
	onProgress: ProgressCallback,
	logFn: (str: string) => void,
	abortSignal: AbortSignal,
): Promise<string> {
	logFn(`Applying balena delta: ${deltaImg}`);

	let auth: Omit<PullPushOptions, 'abortSignal'> | undefined;
	if (token != null) {
		logFn('Using registry auth token');
		auth = {
			authconfig: {
				registrytoken: token,
			},
		};
	}

	await dockerProgress.pull(deltaImg, onProgress, { ...auth, abortSignal });
	return (await docker.getImage(deltaImg).inspect()).Id;
}

export async function isV2DeltaImage(imageName: string): Promise<boolean> {
	const inspect = await docker.getImage(imageName).inspect();

	// It's extremely unlikely that an image is valid if
	// it's smaller than 40 bytes, but a v2 delta always is.
	// For this reason, this is the method that we use to
	// detect when an image is a v2 delta
	return inspect.Size < 40 && inspect.VirtualSize < 40;
}

const getAuthToken = (() => {
	const memoizedGetToken = memoizee(
		async (tokenUrl: string, tokenOpts) => {
			const tokenResponseBody = (
				await (await request.getRequestInstance()).getAsync(tokenUrl, tokenOpts)
			)[1];
			const token = tokenResponseBody?.token;

			if (token == null) {
				throw new ImageAuthenticationError('Authentication error');
			}

			return token;
		},
		{ maxAge: DELTA_TOKEN_TIMEOUT, promise: true, primitive: true },
	);
	return async (
		srcInfo: ImageNameParts,
		dstInfo: ImageNameParts,
		deltaOpts: DeltaFetchOptions,
	): Promise<string> => {
		const tokenOpts: request.requestLib.CoreOptions = {
			auth: {
				user: `d_${deltaOpts.uuid}`,
				pass: deltaOpts.currentApiKey,
				sendImmediately: true,
			},
			json: true,
		};
		const tokenUrl = `${deltaOpts.apiEndpoint}/auth/v1/token?service=${dstInfo.registry}&scope=repository:${dstInfo.imageName}:pull&scope=repository:${srcInfo.imageName}:pull`;
		return memoizedGetToken(tokenUrl, tokenOpts);
	};
})();
