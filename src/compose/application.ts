import * as Bluebird from 'bluebird';
import { ImageInspectInfo } from 'dockerode';
import * as _ from 'lodash';

import DockerUtils from '../lib/docker-utils';
import Logger from '../logger';

import NetworkManager from './network-manager';
import ServiceManager from './service-manager';
import VolumeManager from './volume-manager';

import { NotFoundError } from '../lib/errors';
import { AppDBFormat } from './application-manager';
import { ApplicationParseError } from './errors';
import Images from './images';
import Network from './network';
import Service from './service';
import { ComposeNetworkConfig } from './types/network';
import { ComposeServiceConfig, DeviceMetadata } from './types/service';
import Volume, { ComposeVolumeConfig } from './volume';

interface AppConstructOpts {
	docker: DockerUtils;
	logger: Logger;
}

export class Application {
	private serviceManager: ServiceManager;
	private volumeManager: VolumeManager;
	private networkManger: NetworkManager;
	private images: Images;

	private constructor(
		private opts: AppConstructOpts,
		public appId: number,
		public name: string,
		public commit: string,
		public releaseId: number,
		// Services are keyed by serviceId
		public services: Dictionary<Service>,
		// Networks and volumes are keyed by name
		public volumes: Dictionary<Volume>,
		public networks: Dictionary<Network>,
		// Was this application created from the current state?
		public isCurrent: boolean,
	) {}

	public static async newFromTarget(
		target: AppDBFormat,
		images: Images,
		opts: AppConstructOpts,
		metadata: DeviceMetadata,
	): Promise<Application> {
		// TODO: Validate these configurations using io-ts
		let volumeConfig: Dictionary<Partial<ComposeVolumeConfig>>;
		let serviceConfig: ComposeServiceConfig[];
		let networkConfig: Dictionary<Partial<ComposeNetworkConfig>>;
		try {
			volumeConfig = JSON.parse(target.volumes);
			networkConfig = JSON.parse(target.networks);
			serviceConfig = JSON.parse(target.services);
		} catch (e) {
			throw new ApplicationParseError(e);
		}

		const volumes = _.mapValues(volumeConfig, (config, name) =>
			Volume.fromComposeObject(name, target.appId, config, opts),
		);
		const networks = _.mapValues(networkConfig, (config, name) =>
			Network.fromComposeObject(name, target.appId, config, opts),
		);
		const serviceArray = await Promise.all(
			_.map(serviceConfig, async config => {
				let imageInfo: ImageInspectInfo | undefined;
				try {
					imageInfo = await images.inspectByName(config.image);
				} catch (e) {
					if (!NotFoundError(e)) {
						throw e;
					}
					imageInfo = e;
				}

				const serviceOpts = {
					serviceName: config.serviceName,
					imageInfo,
					...opts,
					...metadata,
				};
				config.imageName = config.image;
				const imageId = _.get(imageInfo, 'Id');
				if (imageId != null) {
					config.image = imageId;
				}

				return Service.fromComposeObject(config, serviceOpts);
			}),
		);
		const services = _.keyBy(serviceArray, 'serviceId');

		_.each(services, svc => {
			// If a named volume is defined in a service, we add
			// it app-wide so that we can track and purge it
			const serviceNamedVolumes = svc.getNamedVolumes();
			for (const name of serviceNamedVolumes) {
				volumes[name] = Volume.fromComposeObject(name, target.appId, {}, opts);
			}
		});

		return new Application(
			opts,
			target.appId,
			target.name,
			target.commit,
			target.releaseId,
			services,
			volumes,
			networks,
			// This state comes from the database and not the
			// current state
			false,
		);
	}
}

export default Application;
