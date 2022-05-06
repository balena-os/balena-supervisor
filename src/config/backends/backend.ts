import * as _ from 'lodash';

export interface ConfigOptions {
	[key: string]: string | string[];
}

export abstract class ConfigBackend {
	// Does this config backend support the given device type?
	public abstract matches(
		deviceType: string,
		metaRelease?: string,
	): Promise<boolean>;

	// A function which reads and parses the configuration options from
	// specific boot config
	public abstract getBootConfig(): Promise<ConfigOptions>;

	// A function to take a set of options and flush to the configuration
	// file/backend
	public abstract setBootConfig(opts: ConfigOptions): Promise<void>;

	// Is the configuration option provided supported by this configuration
	// backend
	public abstract isSupportedConfig(configName: string): boolean;

	// Is this variable a boot config variable for this backend?
	public abstract isBootConfigVar(envVar: string): boolean;

	// Convert a configuration environment variable to a config backend
	// variable
	public abstract processConfigVarName(envVar: string): string | null;

	// Process the value if the environment variable, ready to be written to
	// the backend
	public abstract processConfigVarValue(
		key: string,
		value: string,
	): string | string[];

	// Return the env var name for this config option
	// In situations when the configName is not valid the backend is unable
	// to create the varName equivelant so null is returned.
	// Example an empty string should return null.
	public abstract createConfigVarName(configName: string): string | null;

	// Allow a chosen config backend to be initialised
	public async initialise(): Promise<ConfigBackend> {
		return this;
	}

	// Ensure that all required fields for device type are included in the
	// provided configuration. It is expected to modify the configuration if
	// necessary
	public ensureRequiredConfig(_deviceType: string, conf: ConfigOptions) {
		return conf;
	}
}
