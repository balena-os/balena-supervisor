import { ImageInspectInfo } from 'dockerode';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';

import Config from '../config';
import Docker from '../lib/docker-utils';
import Logger from '../logger';

import Images from './images';
import Network from './network';
import Service from './service';
import Volume from './volume';

import constants = require('../lib/constants');
import { NotFoundError } from '../lib/errors';
import { pathExistsOnHost } from '../lib/fs-utils';
import { DeviceMetadata } from './types/service';
import ServiceManager from './service-manager';
import { NetworkManager } from './network-manager';
import VolumeManager from './volume-manager';

// The internal representation of an application in the
// supervisor's db
export interface DbApp {
	appId: number;
	commit: string;
	name: string;
	source: string;
	releaseId: number;
	services: string;
	networks: string;
	volumes: string;
}

export class Application {
	protected appId: number;
	protected name: string;
	protected commit: string;
	protected releaseId: number;
	protected services: Service[];
	protected networks: Dictionary<Network>;
	protected volumes: Dictionary<Volume>;

	private constructor(
		private config: Config,
		private docker: Docker,
		private logger: Logger,
		private images: Images,
	) {}

	public static async fromDocker(
		services: Service[],
		networks: Dictionary<Network>,
		volumes: Dictionary<Volume>,
		config: Config,
		docker: Docker,
		logger: Logger,
		images: Images,
	) {
		const app = new Application(config, docker, logger, images);

		// We go through all of the provided elements for two
		// reasons, the first being that we need to make sure
		// they're all provided for the same application, the
		// second being that we need to detect the application
		// ID.
		let appId: number;
		const items = (services as Array<{ appId: number }>)
			.concat(_.values(networks))
			.concat(_.values(volumes));

		for (const item of items) {
			if (!appId) {
				appId = item.appId;
			}
		}
	}

	public static async fromComposeObject(
		app: DbApp,
		config: Config,
		docker: Docker,
		logger: Logger,
		images: Images,
	): Promise<Application> {
		const extEnv = await config.get('extendedEnvOptions');
		const supervisorApiHost = await docker
			.getNetworkGateway(constants.supervisorNetworkInterface)
			.catch(() => '127.0.0.1');
		const firmwarePathExists = await pathExistsOnHost('/lib/firmware');
		const modulesPathExists = await pathExistsOnHost('/lib/modules');
		const hostnameOnHost = _.trim(
			await fs.readFile(
				path.join(constants.rootMountPoint, '/etc/hostname'),
				'utf8',
			),
		);

		const configOpts = {
			appName: app.name,
			supervisorApiHost,
			hostPathExists: {
				firmware: firmwarePathExists,
				modules: modulesPathExists,
			},
			hostnameOnHost,
			...extEnv,
		};

		const volumeJson = JSON.parse(app.volumes);
		const volumes = _.mapValues(volumeJson, (volumeConfig, volumeName) => {
			if (volumeConfig == null) {
				volumeConfig = {};
			}
			if (volumeConfig.labels == null) {
				volumeConfig.labels = {};
			}

			return Volume.fromComposeObject(volumeName, app.appId, volumeConfig, {
				docker,
				logger,
			});
		});

		const networkJson = JSON.parse(app.networks);
		const networks = _.mapValues(networkJson, (networkConfig, networkName) => {
			if (networkConfig == null) {
				networkConfig = {};
			}
			return Network.fromComposeObject(networkName, app.appId, networkConfig, {
				docker,
				logger,
			});
		});

		const serviceJson = JSON.parse(app.services);
		const services: Service[] = [];
		for (const svc of serviceJson) {
			let imageInfo: ImageInspectInfo | undefined;
			try {
				imageInfo = await images.inspectByName(svc.image);
			} catch (e) {
				if (!(e instanceof NotFoundError)) {
					throw e;
				}
			}

			const serviceOpts = {
				serviceName: svc.serviceName,
				...imageInfo,
				...configOpts,
			};
			if (imageInfo != null && imageInfo.Id != null) {
				svc.image = imageInfo.Id;
			}

			services.push(
				Service.fromComposeObject(svc, serviceOpts as DeviceMetadata),
			);
		}

		const application = new Application(config, docker, logger, images);
		application.appId = app.appId;
		application.name = app.name;
		application.commit = app.commit;
		application.releaseId = app.releaseId;
		application.services = services;
		application.networks = networks;
		application.volumes = volumes;
		return application;
	}
}

export default Application;
