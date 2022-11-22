import _ from 'lodash';
import { promises as fs } from 'fs';

import { ConfigOptions, ConfigBackend } from './backend';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';
import { ODMDataError } from '../../lib/errors';

/**
 * A backend to handle ODMDATA configuration
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIG_odmdata_configuration = value | "value"
 */

export class Odmdata extends ConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}ODMDATA_`;
	private static bootConfigPath = `${constants.rootMountPoint}/dev/mmcblk0boot0`;
	private static bootConfigLockPath = `${constants.rootMountPoint}/sys/block/mmcblk0boot0/force_ro`;
	private static supportedConfigs = ['configuration'];
	private BYTE_OFFSETS = [1659, 5243, 18043];
	private CONFIG_BYTES = [
		0x0 /* Config Option #1 */, 0x1 /* Config Option #2 */,
		0x6 /* Config Option #3 */, 0x7 /* Config Option #4 */,
		0x2 /* Config Option #5 */, 0x3 /* Config Option #6 */,
	];
	private CONFIG_BUFFER = Buffer.from(this.CONFIG_BYTES);

	public static bootConfigVarRegex = new RegExp(
		'(?:' + _.escapeRegExp(Odmdata.bootConfigVarPrefix) + ')(.+)',
	);

	public async matches(deviceType: string): Promise<boolean> {
		return deviceType.endsWith('-tx2');
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		// Get config buffer from bootConfigPath
		const confBuffer = await this.readBootConfigPath();
		// Parse ConfigOptions from bootConfigPath buffer
		return this.parseOptions(confBuffer);
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		log.info('Attempting to configure ODMDATA.');
		// Filter out unsupported options
		const supportedOptions = _.pickBy(opts, (value, key) => {
			if (!this.isSupportedConfig(key)) {
				log.warn(`Not setting unsupported value: { ${key}: ${value} }`);
				return false;
			}
			return true;
		});
		// Check that there is a configuration mode
		if (!supportedOptions.configuration) {
			log.info('No changes made to ODMDATA configuration.');
			return;
		}
		// Check that configuration mode is supported
		const mode = parseInt(supportedOptions.configuration as string, 10);
		if (mode < 1 || mode > 6) {
			log.error(`Configuration mode of: ${mode} is not supported.`);
			log.info('No changes made to ODMDATA configuration.');
			return;
		}
		log.info(`Setting ODMDATA Configuration Mode #${mode}.`);
		// bootConfigPath is a hardware partition that is READ ONLY
		// We must set bootConfigLockPath to false so we can write to this partition.
		await this.setReadOnly(false);
		try {
			const BYTE_INDEX = mode - 1;
			// Write this byte to each BYTE_OFFSETS in bootConfigPath
			for (const POSITION of this.BYTE_OFFSETS) {
				await this.setByteAtOffset(this.CONFIG_BUFFER, BYTE_INDEX, POSITION);
			}
		} catch (e) {
			log.error('Failed to set configuration mode.', e);
			throw e;
		} finally {
			// Lock RO access
			await this.setReadOnly(true);
		}
		log.info(`Successfully set ODMDATA Configuration Mode #${mode}.`);
	}

	public isSupportedConfig(config: string): boolean {
		return Odmdata.supportedConfigs.includes(config);
	}

	public isBootConfigVar(envVar: string): boolean {
		return envVar.startsWith(Odmdata.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string | null {
		const name = envVar.replace(Odmdata.bootConfigVarRegex, '$1');
		if (name === envVar) {
			return null;
		}
		return name;
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(configName: string): string | null {
		if (configName === '') {
			return null;
		}
		return `${Odmdata.bootConfigVarPrefix}${configName}`;
	}

	private parseOptions(optionsBuffer: Buffer): ConfigOptions {
		log.debug('Attempting to parse ODMDATA from Buffer.');
		// Check that all the values in the buffer match
		if (
			!(
				optionsBuffer.readUInt8(0) === optionsBuffer.readUInt8(1) &&
				optionsBuffer.readUInt8(1) === optionsBuffer.readUInt8(2)
			)
		) {
			log.error(
				'Unable to parse ODMDATA configuration. Data at offsets do not match.',
			);
			throw new ODMDataError(
				'Unable to parse ODMDATA configuration. Data at offsets do not match.',
			);
		}
		// Find the configuration given the optionsBuffer
		const configIndex = this.CONFIG_BYTES.findIndex(
			(_config: number, index: number) => {
				return (
					this.CONFIG_BUFFER.readUInt8(index) === optionsBuffer.readUInt8(0)
				);
			},
		);
		// Check if we found a configuration we support
		if (configIndex === -1) {
			log.error(
				`ODMDATA is set with an unsupported byte: 0x${optionsBuffer.readUInt8(
					0,
				)}`,
			);
			throw new ODMDataError(
				'Unable to parse ODMDATA configuration. Unsupported configuration byte set.',
			);
		}
		// Return supported configuration number currently set
		log.debug(`Parsed Configuration Mode #${configIndex + 1} for ODMDATA.`);
		return {
			configuration: `${configIndex + 1}`,
		};
	}

	private async setByteAtOffset(
		buffer: Buffer,
		byteIndex: number,
		position: number,
	): Promise<void> {
		// Obtain a file handle on bootConfigPath
		const fileHandle = await this.getFileHandle(Odmdata.bootConfigPath);
		// Length is always 1 because this function is for only writing single byte values at a time.
		const LENGTH = 1;
		try {
			await fileHandle.write(buffer, byteIndex, LENGTH, position);
		} catch (e) {
			log.error(`Issue writing to '${Odmdata.bootConfigPath}'`, e);
			throw e;
		} finally {
			if (fileHandle) {
				await fileHandle.close();
			}
		}
	}

	private async getFileHandle(
		file: string,
		flags = 'r+', // Open file for reading and writing. An exception occurs if the file does not exist.
	): Promise<fs.FileHandle> {
		try {
			return await fs.open(file, flags);
		} catch (e: any) {
			switch (e.code) {
				case 'ENOENT':
					log.error(`File not found at: ${file}`);
					throw new ODMDataError(`File not found at: ${file}`);
				case 'EACCES':
					log.error(`Permission denied when opening '${file}'`);
					throw new ODMDataError(`Permission denied when opening '${file}'`);
				default:
					log.error(`Unknown error when opening '${file}'`, e);
					throw new ODMDataError(`Unknown error when opening '${file}'`);
			}
		}
	}

	private async readBootConfigPath(): Promise<Buffer> {
		// Create a buffer to store config byte values
		const valuesBuffer = Buffer.alloc(3);
		// Obtain a file handle on bootConfigPath
		const fileHandle = await this.getFileHandle(Odmdata.bootConfigPath);
		// Set single byte values in buffer at ODMDATA offsets
		try {
			for (let offset = 0; offset < 3; offset++) {
				await fileHandle.read(
					valuesBuffer,
					offset,
					1,
					this.BYTE_OFFSETS[offset],
				);
			}
		} catch (e) {
			log.error(`Issue reading '${Odmdata.bootConfigPath}'`, e);
			throw e;
		} finally {
			if (fileHandle) {
				await fileHandle.close();
			}
		}
		return valuesBuffer;
	}

	private async setReadOnly(value: boolean): Promise<void> {
		// Normalize boolean input to binary output
		const OUTPUT = value === true ? '1' : '0';
		// Obtain a file handle on bootConfigLockPath
		const fileHandle = await this.getFileHandle(Odmdata.bootConfigLockPath);
		// Write RO flag to lock file
		try {
			await fileHandle.write(OUTPUT);
		} catch (e) {
			log.error(`Issue writing to '${Odmdata.bootConfigLockPath}'`, e);
			throw e;
		} finally {
			if (fileHandle) {
				await fileHandle.close();
			}
		}
	}
}
