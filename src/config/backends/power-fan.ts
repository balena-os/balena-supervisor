import { isRight } from 'fp-ts/lib/Either';
import Reporter from 'io-ts-reporters';

import { ConfigBackend } from './backend';
import type { ConfigOptions } from './backend';
import { schemaTypes } from '../schema-type';
import log from '../../lib/supervisor-console';
import * as constants from '../../lib/constants';
import type ConfigJsonConfigBackend from '../configJson';

const isNullOrUndefined = (v: unknown): v is null | undefined =>
	v === null || v === undefined;

/**
 * A backend to handle Jetson power and fan control
 *
 * Supports:
 * 	- {BALENA|RESIN}_HOST_CONFIG_power_mode = "low" | "mid" | "high" | "$MODE_ID"
 * 	- {BALENA|RESIN}_HOST_CONFIG_fan_profile = "quiet" | "default" | "cool" | "$MODE_ID"
 */
export class PowerFanConfig extends ConfigBackend {
	private static readonly PREFIX = `${constants.hostConfigVarPrefix}CONFIG_`;
	private static readonly CONFIGS = new Set(['power_mode', 'fan_profile']);

	private readonly configJson: ConfigJsonConfigBackend;
	public constructor(configJson: ConfigJsonConfigBackend) {
		super();
		this.configJson = configJson;
	}

	private static stripPrefix(name: string): string {
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
		// Get relevant config.json contents
		let rawConf: unknown;
		try {
			rawConf = await this.configJson.get('os');
		} catch (e: unknown) {
			log.error(
				`Failed to read config.json while getting power / fan configs: ${(e as Error).message ?? e}`,
			);
			return {};
		}

		// Decode to known schema from unknown type
		const powerFanConfig = schemaTypes.os.type.decode(rawConf);

		if (isRight(powerFanConfig)) {
			const conf = powerFanConfig.right;
			return {
				...(!isNullOrUndefined(conf.power?.mode) && {
					power_mode: conf.power.mode,
				}),
				...(!isNullOrUndefined(conf.fan?.profile) && {
					fan_profile: conf.fan.profile,
				}),
			};
		} else {
			return {};
		}
	}

	public async setBootConfig(opts: ConfigOptions): Promise<void> {
		// Read power & fan boot configs from config.json
		let rawConf: unknown;
		try {
			rawConf = await this.configJson.get('os');
		} catch (err: unknown) {
			log.error(`${(err as Error).message ?? err}`);
			return;
		}

		// Decode from unknown to known schema
		const decodedCurrentConf = schemaTypes.os.type.decode(rawConf);
		if (!isRight(decodedCurrentConf)) {
			log.error(
				'Failed to decode current power & fan config:',
				Reporter.report(decodedCurrentConf),
			);
			return;
		}
		const currentConf = decodedCurrentConf.right;

		// Filter out unsupported options
		const supportedOpts = Object.fromEntries(
			Object.entries(opts).filter(([key]) => this.isSupportedConfig(key)),
		) as { power_mode?: string; fan_profile?: string };

		const targetConf = structuredClone(currentConf);

		// Iterate over supported configs Set and update targetConf
		// Cast key to only members of PowerFanConfig.CONFIGS to avoid TypeScript errors
		// const key should be of type 'power_mode' or 'fan_profile' ONLY

		// Update or delete power mode
		if ('power_mode' in supportedOpts) {
			targetConf.power = {
				...targetConf.power,
				mode: supportedOpts.power_mode,
			};
		} else {
			delete targetConf.power;
		}

		// Update or delete fan profile
		if ('fan_profile' in supportedOpts) {
			targetConf.fan = {
				...targetConf.fan,
				profile: supportedOpts.fan_profile,
			};
		} else {
			delete targetConf.fan;
		}

		await this.configJson.set({ os: targetConf });
	}

	public isSupportedConfig(name: string): boolean {
		return PowerFanConfig.CONFIGS.has(PowerFanConfig.stripPrefix(name));
	}

	// A static version of isSupportedConfig for other backends to use to exclude power & fan configs
	public static isSupportedConfig(name: string): boolean {
		return PowerFanConfig.CONFIGS.has(PowerFanConfig.stripPrefix(name));
	}

	public isBootConfigVar(envVar: string): boolean {
		return PowerFanConfig.CONFIGS.has(PowerFanConfig.stripPrefix(envVar));
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
