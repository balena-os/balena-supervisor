import * as _ from 'lodash';
import { fs } from 'mz';
import * as Path from 'path';

import Config from '../config';
import Database, { Transaction } from '../db';
import constants = require('../lib/constants');
import DockerUtils from '../lib/docker-utils';
import { pathExistsOnHost } from '../lib/fs-utils';
import { checkInt } from '../lib/validation';
import Images from './images';
import { ComposeNetworkConfig } from './types/network';
import { ComposeServiceConfig, DeviceMetadata } from './types/service';
import { ComposeVolumeConfig } from './volume';

import NetworkManager from './network-manager';
import ServiceManager from './service-manager';
import VolumeManager from './volume-manager';

import Application from './application';
import Logger from '../logger';
import { InternalInconsistencyError } from '../lib/errors';
import { serviceAction } from '../device-api/common';

export interface ApplicationTargetState {
	[appId: string]: {
		// FIXME: Before merge, try this code with an empty
		// state endpoint
		name: string;
		commit: string;
		releaseId: number;
		services: {
			[serviceId: string]: Partial<ComposeServiceConfig>;
		};
		networks: Dictionary<Partial<ComposeNetworkConfig>>;
		volumes: Dictionary<Partial<ComposeVolumeConfig>>;
	};
}

export type DependentTargetState = Dictionary<unknown>;

// FIXME: This is pretty dirty, define the type correctly
export type AppDBFormat = ReturnType<
	ApplicationManager['normalizeAppForDB']
> extends Promise<infer U>
	? U
	: never;

export type ApplicationsById = Dictionary<Application>;

interface ApplicationManagerConstructOpts {
	db: Database;
	config: Config;
	logger: Logger;
}

// FIXME: Make this an event-emitter
export class ApplicationManager {
	private images: Images;
	private db: Database;
	private config: Config;
	private docker: DockerUtils;
	private logger: Logger;
	// FIXME: this
	private proxyvisor: any;

	private serviceManager: ServiceManager;
	private volumeManager: VolumeManager;
	private networkManger: NetworkManager;

	private targetVolatilePerImageId: Dictionary<any> = {};

	public constructor(opts: ApplicationManagerConstructOpts) {
		this.db = opts.db;
		this.config = opts.config;
		this.logger = opts.logger;

		this.docker = new DockerUtils();
		this.images = new Images({
			config: opts.config,
			db: opts.db,
			docker: this.docker,
			logger: opts.logger,
		});

		// FIXME
	}

	public async getCurrentForComparison(): Promise<ApplicationsById> {
		const [service, networks, volumes] = await Promise.all([
			this.serviceManager.getAll(),
			this.networkManger.getAll(),
			this.volumeManager.getAll(),
		]);

		// Take the docker inspect info and create the
		// applications with them
	}

	public async getTargetApps(): Promise<ApplicationsById> {
		const [
			{ extendedEnvOptions: opts, apiEndpoint, localMode },
			supervisorApiHost,
			firmwareExists,
			modulesExists,
			hostnameOnHost,
		] = await Promise.all([
			this.config.getMany(['extendedEnvOptions', 'apiEndpoint', 'localMode']),
			this.docker
				.getNetworkGateway(constants.supervisorNetworkInterface)
				.catch(() => '127.0.0.1'),
			pathExistsOnHost('/lib/firmware'),
			pathExistsOnHost('/lib/modules'),
			fs
				.readFile(Path.join(constants.rootMountPoint, '/etc/hostname'), 'utf8')
				.then(_.trim),
		]);
		const hostPathExists = {
			firmware: firmwareExists,
			modules: modulesExists,
		};

		let source = apiEndpoint;
		if (localMode) {
			source = 'local';
		}

		const dbApps = await this.db.models('app').where({ source });
		const apps: Dictionary<Application> = {};
		for (const app of dbApps) {
			const configOpts = {
				appName: app.name,
				supervisorApiHost,
				hostPathExists,
				hostnameOnHost,
				...opts,
			};

			if (configOpts.uuid == null) {
				throw new InternalInconsistencyError(
					'UUID not defined in application construction',
				);
			}

			const appInstance = await Application.newFromTarget(
				app,
				this.images,
				{ docker: this.docker, logger: this.logger },
				// We know this cast is fine, as we've checked uuid above
				configOpts as DeviceMetadata,
			);

			// FIXME: Find out exactly what
			// targetVolatilePerImageId is and how we should
			// handle it
			// _.each(app.services, svc => {
			// 	if (this.targetVolatilePerImageId[svc.imageId] != null) {
			// 	}
			// });

			apps[app.appId] = appInstance;
		}

		return apps;
	}

	public async setTarget(
		target: ApplicationTargetState,
		dependent: DependentTargetState,
		source: string,
		trx?: Transaction,
	) {
		const setInTransaction = async (trx: Transaction) => {
			const appIds = _.keys(target);
			for (const strAppId of appIds) {
				const appId = checkInt(strAppId);
				if (appId == null) {
					throw new Error('Application without application ID!');
				}
				const clonedApp = {
					..._.cloneDeep(target[appId]),
					appId,
					source,
				};

				const normalised = await this.normalizeAppForDB(clonedApp);
				await this.db.upsertModel('app', normalised, { appId }, trx);
			}

			// Remove all apps from the same source which are no
			// longer referenced
			await trx('app')
				.where({ source })
				.whereNotIn('appId', appIds)
				.del();

			// Update the proxyvisor
			await this.proxyvisor.setTargetInTransaction(dependent, trx);
		};

		if (trx != null) {
			await setInTransaction(trx);
		} else {
			await this.db.transaction(setInTransaction);
		}

		this.targetVolatilePerImageId = {};
	}

	private async normalizeAppForDB(
		app: ApplicationTargetState[''] & { appId: number; source: string },
	) {
		const services = await Promise.all(
			_.map(app.services, async (svc, serviceId) => {
				if (!svc.image) {
					throw new Error(
						'service.image must be defined when storing an app to the database',
					);
				}
				const image = await this.images.normalise(svc.image);
				return {
					...svc,
					appId: app.appId,
					releaseId: app.releaseId,
					serviceId: checkInt(serviceId),
					commit: app.commit,
					image,
				};
			}),
		);

		return {
			appId: app.appId,
			commit: app.commit,
			name: app.name,
			source: app.source,
			releaseId: app.releaseId,
			services: JSON.stringify(services),
			networks: JSON.stringify(app.networks),
			volumes: JSON.stringify(app.volumes),
		};
	}
}

export default ApplicationManager;
