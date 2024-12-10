import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';
import * as t from 'io-ts';
import * as _ from 'lodash';

import { ConfigBackend } from './backend';
import type { ConfigOptions } from './backend';
import { schemaTypes } from '../schema-type';
import log from '../../lib/supervisor-console';
import * as constants from '../../lib/constants';

type ConfigJsonBackend = {
	get: (key: 'os') => Promise<unknown>;
	set: (opts: { os: Record<string, any> }) => Promise<void>;
};

/**
 * A backend to handle Jetson power and fan control
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIG_power_mode = "low" | "mid" | "high" | "default" |"$MODE_ID"
 * 	- {BALENA|RESIN}_HOST_CONFIG_fan_profile = "quiet" | "cool" | "default" |"$MODE_ID"
 */
export class PowerFanConfig extends ConfigBackend {
	private static readonly CONFIGS = new Set(['power_mode', 'fan_profile']);
	private static readonly PREFIX = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static readonly SCHEMA = t.exact(
		t.partial({
			power: t.exact(
				t.partial({
					mode: t.string,
				}),
			),
			fan: t.exact(
				t.partial({
					profile: t.string,
				}),
			),
		}),
	);

	private readonly configJson: ConfigJsonBackend;
	public constructor(configJson: ConfigJsonBackend) {
		super();
		this.configJson = configJson;
	}

	public static stripPrefix(name: string): string {
		if (!name.startsWith(PowerFanConfig.PREFIX)) {
			return name;
		}
		return name.substring(PowerFanConfig.PREFIX.length);
	}

	public async matches(deviceType: string): Promise<boolean> {
		// We only support Jetpack 6 devices for now, which includes all Orin devices
		// except for jetson-orin-nx-xv3 which is still on Jetpack 5 as of OS v5.1.36
		return new Set([
			'jetson-agx-orin-devkit',
			'jetson-agx-orin-devkit-64gb',
			'jetson-orin-nano-devkit-nvme',
			'jetson-orin-nano-seeed-j3010',
			'jetson-orin-nx-seeed-j4012',
			'jetson-orin-nx-xavier-nx-devkit',
		]).has(deviceType);
	}

	public async getBootConfig(): Promise<ConfigOptions> {
		// Get raw config.json contents
		let rawConf: unknown;
		try {
			rawConf = await this.configJson.get('os');
		} catch (e: unknown) {
			log.error(
				`Failed to read config.json while getting power / fan configs: ${(e as Error).message ?? e}`,
			);
			return {};
		}

		// Decode to power fan schema from object type, filtering out unrelated values
		const powerFanConfig = PowerFanConfig.SCHEMA.decode(rawConf);

		if (isRight(powerFanConfig)) {
			const conf = powerFanConfig.right;
			return {
				...(conf.power?.mode != null && {
					power_mode: conf.power.mode,
				}),
				...(conf.fan?.profile != null && {
					fan_profile: conf.fan.profile,
				}),
			};
		} else {
			return {};
		}
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// Read raw configs for "os" key from config.json
		let rawConf;
		try {
			rawConf = await this.configJson.get('os');
		} catch (err: unknown) {
			log.error(`${(err as Error).message ?? err}`);
			return;
		}

		// Decode to "os" object type while leaving in unrelated values
		const maybeCurrentConf = schemaTypes.os.type.decode(rawConf);
		if (!isRight(maybeCurrentConf)) {
			log.error(
				'Failed to decode current os config:',
				Reporter.report(maybeCurrentConf),
			);
			return;
		}
		// Current config could be undefined if there's no os key in config.json, so default to empty object
		const conf = maybeCurrentConf.right ?? {};

		// Update or delete power mode
		if ('power_mode' in opts) {
			conf.power = {
				mode: opts.power_mode,
			};
		} else {
			delete conf?.power;
		}

		// Update or delete fan profile
		if ('fan_profile' in opts) {
			conf.fan = {
				profile: opts.fan_profile,
			};
		} else {
			delete conf?.fan;
		}

		await this.configJson.set({ os: conf });
	}

	public isSupportedConfig = (name: string): boolean => {
		return PowerFanConfig.CONFIGS.has(PowerFanConfig.stripPrefix(name));
	};

	public isBootConfigVar(envVar: string): boolean {
		return PowerFanConfig.CONFIGS.has(PowerFanConfig.stripPrefix(envVar));
	}

	public async isRebootRequired(opts: ConfigOptions): Promise<boolean> {
		const supportedOpts = _.pickBy(
			_.mapKeys(opts, (_value, key) => PowerFanConfig.stripPrefix(key)),
			(_value, key) => this.isSupportedConfig(key),
		);
		const current = await this.getBootConfig();
		// A reboot is only required if the power mode is changing
		return current.power_mode !== supportedOpts.power_mode;
	}

	public processConfigVarName(envVar: string): string {
		return PowerFanConfig.stripPrefix(envVar).toLowerCase();
	}

	public processConfigVarValue(_key: string, value: string): string {
		return value;
	}

	public createConfigVarName(name: string): string | null {
		return `${PowerFanConfig.PREFIX}${name}`;
	}
}
