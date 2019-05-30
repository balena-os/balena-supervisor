import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import * as _ from 'lodash';

import Config from './config';
import Database from './db';
import { Logger } from './logger';

import log from './lib/supervisor-console';

/**
 * This class handles any special cases necessary for switching
 * modes in localMode.
 *
 * Currently this is needed because of inconsistencies in the way
 * that the state machine handles local mode and normal operation.
 * We should aim to remove these inconsistencies in the future.
 */
export class LocalModeManager {
	public constructor(
		public config: Config,
		public docker: Docker,
		public logger: Logger,
		public db: Database,
	) {}

	public async init() {
		// Setup a listener to catch state changes relating to local mode
		this.config.on('change', changed => {
			if (changed.localMode != null) {
				const local = changed.localMode || false;

				// First switch the logger to it's correct state
				this.logger.switchBackend(local);

				// If we're leaving local mode, make sure to remove all of the
				// leftover artifacts
				if (!local) {
					this.removeLocalModeArtifacts();
				}
			}
		});

		// On startup, check if we're in unmanaged mode,
		// as local mode needs to be set
		let unmanagedLocalMode = false;
		if (await this.config.get('unmanaged')) {
			log.info('Starting up in unmanaged mode, activating local mode');
			await this.config.set({ localMode: true });
			unmanagedLocalMode = true;
		}

		const localMode =
			// short circuit the next get if we know we're in local mode
			unmanagedLocalMode || (await this.config.get('localMode'));

		if (!localMode) {
			// Remove any leftovers if necessary
			await this.removeLocalModeArtifacts();
		}
	}

	public async removeLocalModeArtifacts(): Promise<void> {
		try {
			const images = await this.getLocalModeImages();
			const containers = await this.getLocalModeContainers(images);

			await Bluebird.map(containers, containerId => {
				log.debug('Removing local mode container: ', containerId);
				return this.docker.getContainer(containerId).remove({ force: true });
			});
			await Bluebird.map(images, imageId => {
				log.debug('Removing local mode image: ', imageId);
				return this.docker.getImage(imageId).remove({ force: true });
			});

			// Remove any local mode state added to the database
			await this.db
				.models('app')
				.del()
				.where({ source: 'local' });
		} catch (e) {
			log.error('There was an error clearing local mode artifacts: ', e);
		}
	}

	private async getLocalModeImages(): Promise<string[]> {
		// Return all local mode images present on the local docker daemon
		return _.map(
			await this.docker.listImages({
				filters: { label: ['io.resin.local.image=1'] },
			}),
			'Id',
		);
	}

	private async getLocalModeContainers(
		localModeImageIds: string[],
	): Promise<string[]> {
		return _(await this.docker.listContainers())
			.filter(({ Image }) => _.includes(localModeImageIds, Image))
			.map('Id')
			.value();
	}
}

export default LocalModeManager;
