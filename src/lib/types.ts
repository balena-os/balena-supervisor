export interface EnvVarObject {
	[name: string]: string;
}

export interface LabelObject {
	[name: string]: string;
}

// For backwards compatibility we need to use export = Config in config.ts
// so to export these types they have been moved here
export type ConfigValue = string | number | boolean | null;

export interface ConfigMap {
	[key: string]: ConfigValue;
}

export interface ConfigSchema {
	[key: string]: {
		source: string,
		default?: any,
		mutable?: boolean,
		removeIfNull?: boolean,
	};
}
