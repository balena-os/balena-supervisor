import { DockerProgress, ProgressCallback } from 'docker-progress';
import * as Dockerode from 'dockerode';
import * as _ from 'lodash';

import { applyDelta, OutOfSyncError } from 'docker-delta';
import DockerToolbelt = require('docker-toolbelt');

import { SchemaReturn } from '../config/schema-type';
import { envArrayToObject } from './conversions';
import {
	DeltaStillProcessingError,
	InternalInconsistencyError,
	InvalidNetGatewayError,
} from './errors';
import { request, requestLib, resumable } from './request';
import { EnvVarObject } from './types';

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

export class DockerUtils extends DockerToolbelt {
	public dockerProgress: DockerProgress;

	public constructor(opts: Dockerode.DockerOptions) {
		super(opts);
		this.dockerProgress = new DockerProgress({ dockerToolbelt: this });
	}

	public async getRepoAndTag(
		image: string,
	): Promise<{ repo: string; tag: string }> {
		const { registry, imageName, tagName } = await this.getRegistryAndName(
			image,
		);

		let repoName = imageName;

		if (registry != null) {
			repoName = `${registry}/${imageName}`;
		}

		return { repo: repoName, tag: tagName };
	}

	public async fetchDeltaWithProgress(
		imgDest: string,
		deltaOpts: DeltaFetchOptions,
		onProgress: ProgressCallback,
	): Promise<string> {
		const deltaSourceId =
			deltaOpts.deltaSourceId != null
				? deltaOpts.deltaSourceId
				: deltaOpts.deltaSource;

		const timeout = deltaOpts.deltaApplyTimeout;

		if (timeout == null) {
			throw new InternalInconsistencyError(
				'A delta apply timeout is not set in fetchDeltaWithProgress!',
			);
		}

		const log = (str: string) =>
			console.log(`delta(${deltaOpts.deltaSource}): ${str}`);

		if (!_.includes([2, 3], deltaOpts.deltaVersion)) {
			log(
				`Unsupported delta version: ${
					deltaOpts.deltaVersion
				}. Failling back to regular pull`,
			);
			return await this.fetchImageWithProgress(imgDest, deltaOpts, onProgress);
		}

		// Since the supevisor never calls this function with a source anymore,
		// this should never happen, but w ehandle it anyway
		if (deltaOpts.deltaSource == null) {
			log('Falling back to regular pull due to lack of a delta source');
			return this.fetchImageWithProgress(imgDest, deltaOpts, onProgress);
		}

		const docker = this;
		log(`Starting delta to ${imgDest}`);

		const [dstInfo, srcInfo] = await Promise.all([
			this.getRegistryAndName(imgDest),
			this.getRegistryAndName(deltaOpts.deltaSource),
		]);

		const tokenEndpoint = `${deltaOpts.apiEndpoint}/auth/v1/token`;
		const tokenOpts: requestLib.CoreOptions = {
			auth: {
				user: `d_${deltaOpts.uuid}`,
				pass: deltaOpts.currentApiKey,
				sendImmediately: true,
			},
		};
		const tokenUrl = `${tokenEndpoint}?service=${
			dstInfo.registry
		}&scope=repository:${dstInfo.imageName}:pull&scope=repository:${
			srcInfo.imageName
		}:pull`;

		const tokenResponseBody = (await request.getAsync(tokenUrl, tokenOpts))[1];
		const token = tokenResponseBody != null ? tokenResponseBody.token : null;

		const opts: requestLib.CoreOptions = {
			followRedirect: false,
			timeout: deltaOpts.deltaRequestTimeout,
		};

		if (token != null) {
			opts.auth = {
				bearer: token,
				sendImmediately: true,
			};
		}

		const url = `${deltaOpts.deltaEndpoint}/api/v${
			deltaOpts.deltaVersion
		}/delta?src=${deltaOpts.deltaSource}&dest=${imgDest}`;

		const [res, data] = await request.getAsync(url, opts);
		if (res.statusCode === 502 || res.statusCode === 504) {
			throw new DeltaStillProcessingError();
		}
		let id: string;
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
							`Got ${res.statusCode} when request image from delta server.`,
						);
					}
					const deltaUrl = res.headers['location'];
					const deltaSrc = deltaSourceId;
					const resumeOpts = {
						timeout: deltaOpts.deltaRequestTimeout,
						maxRetries: deltaOpts.deltaRetryCount,
						retryInterval: deltaOpts.deltaRetryInterval,
					};
					id = await DockerUtils.applyRsyncDelta(
						deltaSrc,
						deltaUrl,
						timeout,
						resumeOpts,
						onProgress,
						log,
					);
					break;
				case 3:
					if (res.statusCode !== 200) {
						throw new Error(
							`Got ${
								res.statusCode
							} when requesting v3 delta from delta server.`,
						);
					}
					let name;
					try {
						name = JSON.parse(data).name;
					} catch (e) {
						throw new Error(
							`Got an error when parsing delta server response for v3 delta: ${e}`,
						);
					}
					id = await DockerUtils.applyBalenaDelta(
						docker,
						name,
						token,
						onProgress,
						log,
					);
					break;
				default:
					throw new Error(
						`Unsupposed delta version: ${deltaOpts.deltaVersion}`,
					);
			}
		} catch (e) {
			if (e instanceof OutOfSyncError) {
				log('Falling back to regular pull due to delta out of sync error');
				return await this.fetchImageWithProgress(
					imgDest,
					deltaOpts,
					onProgress,
				);
			} else {
				log(`Delta failed with ${e}`);
				throw e;
			}
		}

		log(`Delta applied successfully`);
		return id;
	}

	public async fetchImageWithProgress(
		image: string,
		{ uuid, currentApiKey }: FetchOptions,
		onProgress: ProgressCallback,
	): Promise<string> {
		const { registry } = await this.getRegistryAndName(image);

		const dockerOpts = {
			authconfig: {
				username: `d_${uuid}`,
				password: currentApiKey,
				serverAddress: registry,
			},
		};

		await this.dockerProgress.pull(image, onProgress, dockerOpts);
		return (await this.getImage(image).inspect()).Id;
	}

	public async getImageEnv(id: string): Promise<EnvVarObject> {
		const inspect = await this.getImage(id).inspect();

		try {
			return envArrayToObject(_.get(inspect, ['Config', 'Env'], []));
		} catch (e) {
			console.log('Error getting env from image', e, e.stack);
			return {};
		}
	}

	public async getNetworkGateway(networkName: string): Promise<string> {
		if (networkName === 'host') {
			return '127.0.0.1';
		}

		const network = await this.getNetwork(networkName).inspect();
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

	private static applyRsyncDelta(
		imgSrc: string,
		deltaUrl: string,
		applyTimeout: number,
		opts: RsyncApplyOptions,
		onProgress: ProgressCallback,
		log: (str: string) => void,
	): Promise<string> {
		log('Applying rsync delta...');

		return new Promise((resolve, reject) => {
			const req = resumable(Object.assign({ url: deltaUrl }, opts));
			req
				.on('progress', onProgress)
				.on('retry', onProgress)
				.on('error', reject)
				.on('response', res => {
					if (res.statusCode !== 200) {
						reject(
							new Error(
								`Got ${res.statusCode} when requesting delta from storage.`,
							),
						);
					} else if (parseInt(res.headers['content-length'] || '0', 10) === 0) {
						reject(new Error('Invalid delta URL'));
					} else {
						const deltaStream = applyDelta(imgSrc, {
							log,
							timeout: applyTimeout,
						});
						res
							.pipe(deltaStream)
							.on('id', id => resolve(`sha256:${id}`))
							.on('error', err => {
								log(`Delta stream emitted error: ${err}`);
								req.abort();
								reject(err);
							});
					}
				});
		});
	}

	private static async applyBalenaDelta(
		docker: DockerUtils,
		deltaImg: string,
		token: string | null,
		onProgress: ProgressCallback,
		log: (str: string) => void,
	): Promise<string> {
		log('Applying balena delta...');

		let auth: Dictionary<unknown> | undefined;
		if (token != null) {
			log('Using registry auth token');
			auth = {
				authconfig: {
					registrytoken: token,
				},
			};
		}

		await docker.dockerProgress.pull(deltaImg, onProgress, auth);
		return (await docker.getImage(deltaImg).inspect()).Id;
	}
}

export default DockerUtils;
