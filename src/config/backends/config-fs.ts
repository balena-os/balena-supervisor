import _ from 'lodash';
import { promises as fs } from 'fs';
import path from 'path';

import type { ConfigOptions } from './backend';
import { ConfigBackend } from './backend';
import { exec, exists } from '../../lib/fs-utils';
import * as hostUtils from '../../lib/host-utils';
import * as constants from '../../lib/constants';
import * as logger from '../../logging';
import log from '../../lib/supervisor-console';

/**
 * A backend to handle ConfigFS host configuration
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIGFS_ssdt = value | "value" | "value1","value2"
 */

type ConfigfsConfig = Dictionary<string[]>;

export class ConfigFs extends ConfigBackend {
	private readonly SystemAmlFiles = hostUtils.pathOnRoot('boot/acpi-tables');
	private readonly ConfigFilePath = hostUtils.pathOnBoot('configfs.json');
	private readonly ConfigfsMountPoint =
		hostUtils.pathOnRoot('sys/kernel/config');
	private readonly ConfigVarNamePrefix = `${constants.hostConfigVarPrefix}CONFIGFS_`;

	// supported backend for the following device types...
	public static readonly SupportedDeviceTypes = ['up-board'];
	private static readonly BootConfigVars = ['ssdt'];

	private stripPrefix(name: string): string {
		if (!name.startsWith(this.ConfigVarNamePrefix)) {
			return name;
		}
		return name.substr(this.ConfigVarNamePrefix.length);
	}

	private async listLoadedAcpiTables(): Promise<string[]> {
		const acpiTablesDir = path.join(this.ConfigfsMountPoint, 'acpi/table');
		return await fs.readdir(acpiTablesDir);
	}

	private async loadAML(aml: string): Promise<boolean> {
		if (!aml) {
			return false;
		}

		const amlSrcPath = path.join(this.SystemAmlFiles, `${aml}.aml`);
		// log to system log if the AML doesn't exist...
		if (!(await exists(amlSrcPath))) {
			log.error(`Missing AML for '${aml}'. Unable to load.`);
			if (logger) {
				logger.logSystemMessage(
					`Missing AML for '${aml}'. Unable to load.`,
					{ aml, path: amlSrcPath },
					'Load AML error',
					false,
				);
			}
			return false;
		}

		const amlDstPath = path.join(this.ConfigfsMountPoint, 'acpi/table', aml);
		try {
			const loadedTables = await this.listLoadedAcpiTables();

			if (loadedTables.indexOf(aml) < 0) {
				await fs.mkdir(amlDstPath);
			}

			log.info(`Loading AML ${aml}`);
			// we use `cat` here as this didn't work when using `cp` and all
			// examples of this loading mechanism use `cat`.
			await exec(`cat ${amlSrcPath} > ${path.join(amlDstPath, 'aml')}`);

			const [oemId, oemTableId, oemRevision] = await Promise.all([
				fs.readFile(path.join(amlDstPath, 'oem_id'), 'utf8'),
				fs.readFile(path.join(amlDstPath, 'oem_table_id'), 'utf8'),
				fs.readFile(path.join(amlDstPath, 'oem_revision'), 'utf8'),
			]);

			log.info(
				`AML: ${oemId.trim()} ${oemTableId.trim()} (Rev ${oemRevision.trim()})`,
			);
		} catch (e) {
			log.error(`Issue while loading AML ${aml}`, e);
		}
		return true;
	}

	private async readConfigJSON(): Promise<ConfigfsConfig> {
		// if we don't yet have a config file, just return an empty result...
		if (!(await exists(this.ConfigFilePath))) {
			log.info('Empty ConfigFS config file');
			return {};
		}

		// read the config file...
		try {
			const content = await hostUtils.readFromBoot(
				this.ConfigFilePath,
				'utf-8',
			);
			return JSON.parse(content);
		} catch (err) {
			log.error('Unable to deserialise ConfigFS configuration.', err);
			return {};
		}
	}

	private async writeConfigJSON(config: ConfigfsConfig): Promise<void> {
		await hostUtils.writeToBoot(this.ConfigFilePath, JSON.stringify(config));
	}

	private async loadConfiguredSsdt(config: ConfigfsConfig): Promise<void> {
		if (Array.isArray(config['ssdt'])) {
			log.info('Loading configured SSDTs');
			for (const aml of config['ssdt']) {
				await this.loadAML(aml);
			}
		}
	}

	public async initialise(): Promise<ConfigFs> {
		try {
			await super.initialise();

			// load the acpi_configfs module...
			await exec('modprobe acpi_configfs');

			// read the existing config file...
			const config = await this.readConfigJSON();

			// write the config back out (reformatting it)
			await this.writeConfigJSON(config);

			// load the configured SSDT AMLs...
			await this.loadConfiguredSsdt(config);
			log.success('Initialised ConfigFS');
		} catch (error) {
			log.error(error);
			await logger.initialized();
			logger.logSystemMessage(
				'Unable to initialise ConfigFS',
				{ error },
				'ConfigFS initialisation error',
			);
		}
		return this;
	}

	public async matches(deviceType: string): Promise<boolean> {
		return ConfigFs.SupportedDeviceTypes.includes(deviceType);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		const options: ConfigOptions = {};

		// read the config file...
		const config = await this.readConfigJSON();

		// see which SSDTs we have configured...
		const ssdt = config['ssdt'];
		if (Array.isArray(ssdt) && ssdt.length > 0) {
			// we have some...
			options['ssdt'] = ssdt;
		}
		return options;
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// read the config file...
		const config = await this.readConfigJSON();

		// see if the target state defined some SSDTs...
		const ssdtKey = `${this.ConfigVarNamePrefix}ssdt`;
		if (opts[ssdtKey]) {
			// it did, so update the config with theses...
			config['ssdt'] = _.castArray(opts[ssdtKey]);
		} else {
			// it did not, so remove any existing SSDTs from the config...
			delete config['ssdt'];
		}

		// store the new config to disk...
		await this.writeConfigJSON(config);
	}

	public isSupportedConfig(name: string): boolean {
		return ConfigFs.BootConfigVars.includes(this.stripPrefix(name));
	}

	public isBootConfigVar(name: string): boolean {
		return ConfigFs.BootConfigVars.includes(this.stripPrefix(name));
	}

	public processConfigVarName(name: string): string {
		return name;
	}

	public processConfigVarValue(name: string, value: string): string | string[] {
		switch (this.stripPrefix(name)) {
			case 'ssdt':
				// value could be a single value, so just add to an array and return...
				if (!value.startsWith('"')) {
					return [value];
				} else {
					// or, it could be parsable as the content of a JSON array; "value" | "value1","value2"
					return value.split(',').map((v) => v.replace(/"/g, '').trim());
				}
			default:
				return value;
		}
	}

	public createConfigVarName(name: string): string {
		return `${this.ConfigVarNamePrefix}${name}`;
	}
}
