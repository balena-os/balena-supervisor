import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';

import * as constants from '../../lib/constants';
import { exists } from '../../lib/fs-utils';
import * as hostUtils from '../../lib/host-utils';
import log from '../../lib/supervisor-console';
import { ConfigBackend, ConfigOptions } from './backend';

export class SplashImage extends ConfigBackend {
	private static readonly BASEPATH = hostUtils.pathOnBoot('splash');
	private static readonly DEFAULT = path.join(
		SplashImage.BASEPATH,
		'balena-logo-default.png',
	);
	private static readonly FILENAMES = ['balena-logo.png', 'resin-logo.png'];
	private static readonly PREFIX = `${constants.hostConfigVarPrefix}SPLASH_`;
	private static readonly CONFIGS = ['image'];
	private static readonly DATA_URI_REGEX = /^data:(.+);base64,(.*)$/;

	// Check the first 8 bytes of a buffer for a PNG header
	// Source: https://github.com/sindresorhus/is-png/blob/master/index.js
	private isPng(buffer: Buffer) {
		if (!buffer || buffer.length < 8) {
			return false;
		}

		return (
			buffer[0] === 0x89 &&
			buffer[1] === 0x50 &&
			buffer[2] === 0x4e &&
			buffer[3] === 0x47 &&
			buffer[4] === 0x0d &&
			buffer[5] === 0x0a &&
			buffer[6] === 0x1a &&
			buffer[7] === 0x0a
		);
	}

	// Get the file path for the splash image for the underlying
	// system
	private async getSplashPath(): Promise<string> {
		// TODO: this is not perfect, if the file was supposed to be
		// resin-logo.png and for some reason is not present on the folder
		// the supervisor will try to write new images from the API into
		// balena-logo.png to no effect. Ideally this should be configurable
		// as a constant that is provided on supervisor container launch.
		const [
			// If no logo is found, assume the file is `balena-logo.png`
			splashFile = path.join(SplashImage.BASEPATH, 'balena-logo.png'),
		] = (
			await Bluebird.resolve(fs.readdir(SplashImage.BASEPATH))
				// Read the splash dir (will throw if the path does not exist)
				// And filter valid filenames
				.filter((filename) => SplashImage.FILENAMES.includes(filename))
		)
			// Sort by name, so in case both files are defined, balena-logo will
			// be chosen
			.sort()
			// Convert to full path
			.map((filename) => path.join(SplashImage.BASEPATH, filename));

		return splashFile;
	}

	// Returns the base64 contents of the splash image
	private async readSplashImage(where?: string): Promise<string> {
		// Read from defaultPath unless where is defined
		where = where ?? (await this.getSplashPath());

		// read the image file...
		return (await hostUtils.readFromBoot(where)).toString('base64');
	}

	// Write a splash image provided as a base64 string
	private async writeSplashImage(image: string, where?: string): Promise<void> {
		// Write to defaultPath unless where is defined
		where = where ?? (await this.getSplashPath());

		const buffer = Buffer.from(image, 'base64');
		if (this.isPng(buffer)) {
			// Write the buffer to the given location
			await hostUtils.writeToBoot(where, buffer);
		} else {
			log.error(
				'Expected splash image to be a base64 encoded PNG image. Skipping write.',
			);
		}
	}

	private stripPrefix(name: string): string {
		if (!name.startsWith(SplashImage.PREFIX)) {
			return name;
		}
		return name.substr(SplashImage.PREFIX.length);
	}

	public createConfigVarName(name: string): string {
		return `${SplashImage.PREFIX}${name}`;
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		try {
			const defaultImg = await this.readSplashImage(SplashImage.DEFAULT);
			const img = await this.readSplashImage();

			// If the image is the same as the default image
			// return nothing
			if (img !== defaultImg) {
				return {
					image: `data:image/png;base64,${img}`,
				};
			}
		} catch (e) {
			log.warn('Failed to read splash image:', e);
		}
		return {};
	}

	public async initialise(): Promise<SplashImage> {
		try {
			await super.initialise();

			// The default boot image file has already
			// been created
			if (await exists(SplashImage.DEFAULT)) {
				return this;
			}

			// read the existing image file...
			const image = await this.readSplashImage();

			// write the image to the DEFAULT path
			await this.writeSplashImage(image, SplashImage.DEFAULT);

			log.success('Initialised splash image backend');
		} catch (error) {
			log.warn('Could not initialise splash image backend', error);
		}
		return this;
	}

	public ensureRequiredConfig(_deviceType: string, conf: ConfigOptions) {
		// If the value from the cloud is empty, it is the same as no definition
		if (
			!_.isUndefined(conf.image) &&
			_.isEmpty((conf.image as string).trim())
		) {
			delete conf.image;
		}
		return conf;
	}

	public isSupportedConfig(name: string): boolean {
		return SplashImage.CONFIGS.includes(this.stripPrefix(name).toLowerCase());
	}

	public isBootConfigVar(name: string): boolean {
		return SplashImage.CONFIGS.includes(this.stripPrefix(name).toLowerCase());
	}

	public async matches(_deviceType: string): Promise<boolean> {
		// all device types
		return true;
	}

	public processConfigVarName(name: string): string {
		return this.stripPrefix(name).toLowerCase();
	}

	public processConfigVarValue(
		_name: string,
		value: string,
	): string | string[] {
		// check data url regex
		const matches = value.match(SplashImage.DATA_URI_REGEX);
		if (!_.isNull(matches)) {
			const [, media, data] = matches;
			const [type] = media.split(';'); // discard mediatype parameters

			return `data:${type};base64,${data}`;
		}

		if (!_.isEmpty(value.trim())) {
			// Assume data is base64 encoded. If is not, setBootConfig will fail
			return `data:image/png;base64,${value}`;
		}
		return value.trim();
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// If no splash image is defined, revert to the default splash image
		const value = !_.isEmpty(opts.image)
			? (opts.image as string)
			: await this.readSplashImage(SplashImage.DEFAULT);

		// If it is a data URI get only the data part
		const [, image] = value.startsWith('data:') ? value.split(',') : [, value];

		// Rewrite the splash image
		await this.writeSplashImage(image);
	}
}
