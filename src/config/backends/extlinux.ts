import _ from 'lodash';
import semver from 'semver';

import type { ConfigOptions } from './backend';
import { ConfigBackend } from './backend';
import type { ExtlinuxFile, Directive } from './extlinux-file';
import { AppendDirective, FDTDirective } from './extlinux-file';
import * as constants from '../../lib/constants';
import log from '../../lib/supervisor-console';
import { ExtLinuxEnvError, ExtLinuxParseError } from '../../lib/errors';
import * as hostUtils from '../../lib/host-utils';

// The OS version when extlinux moved to READ ONLY partition
const EXTLINUX_READONLY = '2.47.0';

/**
 * A backend to handle extlinux host configuration
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_EXTLINUX_isolcpus = value | "value" | "value1","value2"
 * 	- {BALENA|RESIN}_HOST_EXTLINUX_fdt = value | "value"
 */

export class Extlinux extends ConfigBackend {
	private static bootConfigVarPrefix = `${constants.hostConfigVarPrefix}EXTLINUX_`;
	private static bootConfigPath = hostUtils.pathOnBoot(
		`extlinux/extlinux.conf`,
	);
	private static supportedConfigValues = ['isolcpus', 'fdt'];
	private static supportedDirectives = ['APPEND', 'FDT'];

	private fdtDirective = new FDTDirective();
	private appendDirective = new AppendDirective(
		// Pass in list of supportedConfigValues that APPEND can have
		Extlinux.supportedConfigValues.filter((v) => !this.isDirective(v)),
	);

	public static bootConfigVarRegex = new RegExp(
		'(?:' + _.escapeRegExp(Extlinux.bootConfigVarPrefix) + ')(.+)',
	);

	public async matches(
		deviceType: string,
		metaRelease: string | undefined,
	): Promise<boolean> {
		return (
			// Only test metaRelease with Jetson devices
			deviceType.startsWith('jetson-') &&
			typeof metaRelease === 'string' &&
			semver.lt(metaRelease, EXTLINUX_READONLY)
		);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		let confContents: string;

		try {
			confContents = await hostUtils.readFromBoot(
				Extlinux.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new ExtLinuxEnvError(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		// Parse ExtlinuxFile from file contents
		const parsedBootFile = Extlinux.parseExtlinuxFile(confContents);

		// Get default label to know which label entry to parse
		const defaultLabel = Extlinux.findDefaultLabel(parsedBootFile);

		// Get the label entry we will parse
		const labelEntry = Extlinux.getLabelEntry(parsedBootFile, defaultLabel);

		// Parse APPEND directive and filter out unsupported values
		const appendConfig = _.pickBy(
			this.appendDirective.parse(labelEntry),
			(_value, key) => this.isSupportedConfig(key),
		);

		// Parse FDT directive
		const fdtConfig = this.fdtDirective.parse(labelEntry);

		return {
			...appendConfig,
			...fdtConfig,
		};
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// First get a representation of the configuration file, with all balena-supported configuration removed
		let confContents: string;

		try {
			confContents = await hostUtils.readFromBoot(
				Extlinux.bootConfigPath,
				'utf-8',
			);
		} catch {
			// In the rare case where the user might have deleted extlinux conf file between linux boot and supervisor boot
			// We do not have any backup to fallback too; warn the user of a possible brick
			throw new ExtLinuxEnvError(
				'Could not find extlinux file. Device is possibly bricked',
			);
		}

		// Parse ExtlinuxFile from file contents
		const parsedBootFile = Extlinux.parseExtlinuxFile(confContents);

		// Get default label to know which label entry to edit
		const defaultLabel = Extlinux.findDefaultLabel(parsedBootFile);

		// Get the label entry we will edit
		const defaultEntry = Extlinux.getLabelEntry(parsedBootFile, defaultLabel);

		// Set `FDT` directive if a value is provided
		if (opts.fdt) {
			defaultEntry.FDT = this.fdtDirective.generate(opts);
		}

		// Remove unsupported options
		const appendOptions = _.pickBy(
			opts,
			// supportedConfigValues has values AND directives so we must filter directives out
			(_value, key) => this.isSupportedConfig(key) && !this.isDirective(key),
		);

		// Add config values to `APPEND` directive
		defaultEntry.APPEND = this.appendDirective.generate(
			appendOptions,
			defaultEntry.APPEND,
		);

		// Write new extlinux configuration
		return await hostUtils.writeToBoot(
			Extlinux.bootConfigPath,
			Extlinux.extlinuxFileToString(parsedBootFile),
		);
	}

	public isSupportedConfig(configName: string): boolean {
		return Extlinux.supportedConfigValues.includes(configName);
	}

	public isBootConfigVar(envVar: string): boolean {
		return envVar.startsWith(Extlinux.bootConfigVarPrefix);
	}

	public processConfigVarName(envVar: string): string {
		return envVar.replace(Extlinux.bootConfigVarRegex, '$1');
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(configName: string): string {
		return `${Extlinux.bootConfigVarPrefix}${configName}`;
	}

	private isDirective(configName: string): boolean {
		return Extlinux.supportedDirectives.includes(configName.toUpperCase());
	}

	private static parseExtlinuxFile(confStr: string): ExtlinuxFile {
		const file: ExtlinuxFile = {
			globals: {},
			labels: {},
		};

		// Split by line and filter any comments and empty lines
		const lines = confStr.split(/(?:\r?\n[\s#]*)+/);
		let lastLabel = '';

		for (const line of lines) {
			const match = line.match(/^\s*(\w+)\s?(.*)$/);
			if (match == null) {
				log.warn(`Could not read extlinux entry: ${line}`);
				continue;
			}
			let directive = match[1].toUpperCase();
			let value = match[2];

			// Special handling for the MENU directive
			if (directive === 'MENU') {
				const parts = value.split(' ');
				directive = `MENU ${parts[0]}`;
				value = parts.slice(1).join(' ');
			}

			if (directive !== 'LABEL') {
				if (lastLabel === '') {
					// Global options
					file.globals[directive] = value;
				} else {
					// Label specific options
					file.labels[lastLabel][directive] = value;
				}
			} else {
				lastLabel = value;
				file.labels[lastLabel] = {};
			}
		}

		return file;
	}

	private static extlinuxFileToString(file: ExtlinuxFile): string {
		let ret = '';
		_.each(file.globals, (value, directive) => {
			ret += `${directive} ${value}\n`;
		});
		_.each(file.labels, (directives, key) => {
			ret += `LABEL ${key}\n`;
			_.each(directives, (value, directive) => {
				ret += `${directive} ${value}\n`;
			});
		});
		return ret;
	}

	private static findDefaultLabel(file: ExtlinuxFile): string {
		if (!file.globals.DEFAULT) {
			throw new ExtLinuxParseError(
				'Could not find default entry for extlinux.conf file',
			);
		}
		return file.globals.DEFAULT;
	}

	private static getLabelEntry(file: ExtlinuxFile, label: string): Directive {
		const labelEntry = file.labels[label];
		if (labelEntry == null) {
			throw new ExtLinuxParseError(
				`Cannot find label entry (label: ${label}) for extlinux.conf file`,
			);
		}
		return labelEntry;
	}
}
