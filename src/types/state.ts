import * as t from 'io-ts';

import type { ContractObject } from '@balena/contrato';

import {
	DockerName,
	EnvVarObject,
	ConfigVarObject,
	LabelObject,
	NumericIdentifier,
	ShortString,
	DeviceName,
	nonEmptyRecord,
} from './basic';

export interface ComposeVolumeConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	labels: LabelObject;
}

export interface ComposeNetworkConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	ipam: {
		driver: string;
		config: Array<
			Partial<{
				subnet: string;
				ip_range: string;
				gateway: string;
				aux_addresses: Dictionary<string>;
			}>
		>;
		options: Dictionary<string>;
	};
	enable_ipv6: boolean;
	internal: boolean;
	labels: Dictionary<string>;
	config_only: boolean;
}

export type DeviceLegacyReport = Partial<{
	api_port: number;
	api_secret: string | null;
	ip_address: string;
	os_version: string | null;
	os_variant: string | null;
	supervisor_version: string;
	provisioning_progress: null | number;
	provisioning_state: string;
	status: string;
	update_failed: boolean;
	update_pending: boolean;
	update_downloaded: boolean;
	logs_channel: string | null;
	mac_address: string | null;
}>;

// This is the state that is sent to the cloud
export interface DeviceLegacyState {
	local?: {
		config?: Dictionary<string>;
		is_on__commit?: string;
		apps?: {
			[appId: string]: {
				services: {
					[serviceId: string]: {
						status: string;
						releaseId: number;
						download_progress: number | null;
					};
				};
			};
		};
	} & DeviceLegacyReport;
	commit?: string;
}

// Return a type with a default value
export const withDefault = <T extends t.Any>(
	type: T,
	defaultValue: t.TypeOf<T>,
): t.Type<t.TypeOf<T>> =>
	new t.Type(
		type.name,
		type.is,
		(v, c) => type.validate(v != null ? v : defaultValue, c),
		type.encode,
	);
/**
 * Utility function to return a io-ts type from a native typescript
 * type.
 *
 * **IMPORTANT**: This will NOT validate the type, just allow to combine the generated
 * type with other io-ts types.
 *
 * Please do NOT export. This is a placeholder while updating other related
 * types to io-ts
 *
 * Example:
 * ```
 * export
 *
 * type MyType = { one: string };
 * const MyType = fromType<MyType>('MyType'); // both name and generic value are required :(
 * const OtherType = t.type({name: t.string, other: MyType });
 * OtherType.decode({name: 'john', other: {one: 1}); // will decode to true
 *
 * type OtherType = t.TypeOf<typeof OtherType>; // will have the correct type definition
 * ```
 */
const fromType = <T extends object>(name: string) =>
	new t.Type<T>(
		name,
		(input: unknown): input is T => typeof input === 'object' && input !== null,
		(input, context) =>
			typeof input === 'object' && input !== null
				? (t.success(input) as t.Validation<T>)
				: t.failure(
						input,
						context,
						`Expected value to be an object of type ${name}, got: ${input}`,
					),
		t.identity,
	);

// Alias short string to UUID so code reads more clearly
export const UUID = ShortString;

/** ***************
 * Current state *
 *****************/
const ServiceState = t.intersection([
	t.type({
		image: t.string,
		status: t.string,
	}),
	t.partial({
		download_progress: t.union([t.number, t.null]),
	}),
]);
export type ServiceState = t.TypeOf<typeof ServiceState>;

const ReleaseState = t.type({
	services: t.record(DockerName, ServiceState),
});
export type ReleaseState = t.TypeOf<typeof ReleaseState>;

const ReleasesState = t.record(UUID, ReleaseState);
export type ReleasesState = t.TypeOf<typeof ReleasesState>;

const AppState = t.intersection([
	t.type({
		releases: ReleasesState,
	}),
	t.partial({
		release_uuid: UUID,
	}),
]);
export type AppState = t.TypeOf<typeof AppState>;

const DeviceReport = t.partial({
	name: t.string,
	status: t.string,
	os_version: t.union([t.string, t.null]),
	os_variant: t.union([t.string, t.null]),
	supervisor_version: t.string,
	provisioning_progress: t.union([t.number, t.null]),
	provisioning_state: t.string,
	ip_address: t.string,
	mac_address: t.union([t.string, t.null]),
	api_port: t.number,
	api_secret: t.union([t.string, t.null]),
	logs_channel: t.union([t.string, t.null]),
	memory_usage: t.number,
	memory_total: t.number,
	storage_block_device: t.string,
	storage_usage: t.number,
	storage_total: t.number,
	cpu_temp: t.number,
	cpu_usage: t.number,
	cpu_id: t.string,
	is_undervolted: t.boolean,
	update_failed: t.boolean,
	update_pending: t.boolean,
	update_downloaded: t.boolean,
});
export type DeviceReport = t.TypeOf<typeof DeviceReport>;

export const DeviceState = t.record(
	UUID,
	t.intersection([
		DeviceReport,
		t.partial({
			apps: t.record(UUID, AppState),
		}),
	]),
);
export type DeviceState = t.TypeOf<typeof DeviceState>;

/** **************
 * Target state *
 ****************/
/**
 * A target service has docker image, a set of environment variables
 * and labels as well as one or more configurations
 */
export const TargetService = t.intersection([
	t.type({
		/**
		 * @deprecated to be removed in state v4
		 */
		id: NumericIdentifier,
		/**
		 * @deprecated to be removed in state v4
		 */
		image_id: NumericIdentifier,
		image: ShortString,
		environment: EnvVarObject,
		labels: LabelObject,
	}),
	t.partial({
		running: withDefault(t.boolean, true),
		contract: fromType<ContractObject>('ContractObject'),
		// This will not be validated
		// TODO: convert ServiceComposeConfig to a io-ts type
		composition: t.record(t.string, t.unknown),
	}),
]);
export type TargetService = t.TypeOf<typeof TargetService>;

/**
 * Target state release format
 */
export const TargetRelease = t.type({
	/**
	 * @deprecated to be removed in state v4
	 */
	id: NumericIdentifier,
	services: withDefault(t.record(DockerName, TargetService), {}),
	volumes: withDefault(
		t.record(
			DockerName,
			// TargetVolume format will NOT be validated
			// TODO: convert ComposeVolumeConfig to a io-ts type
			fromType<Partial<ComposeVolumeConfig>>('Volume'),
		),
		{},
	),
	networks: withDefault(
		t.record(
			DockerName,
			// TargetNetwork format will NOT be validated
			// TODO: convert ComposeVolumeConfig to a io-ts type
			fromType<Partial<ComposeNetworkConfig>>('Network'),
		),
		{},
	),
});
export type TargetRelease = t.TypeOf<typeof TargetRelease>;

export const TargetAppClass = t.union([
	t.literal('fleet'),
	t.literal('app'),
	t.literal('block'),
]);
export type TargetAppClass = t.TypeOf<typeof TargetAppClass>;

/**
 * A target app is composed by a release and a collection of volumes and
 * networks.
 */
const TargetApp = t.intersection(
	[
		t.type({
			/**
			 * @deprecated to be removed in state v4
			 */
			id: NumericIdentifier,
			name: ShortString,
			// There should be only one fleet class app in the target state but we
			// are not validating that here
			class: withDefault(TargetAppClass, 'fleet'),
			// TODO: target release must have at most one value. Should we validate?
			releases: withDefault(t.record(UUID, TargetRelease), {}),
		}),
		t.partial({
			parent_app: UUID,
			is_host: t.boolean,
		}),
	],
	'App',
);
export type TargetApp = t.TypeOf<typeof TargetApp>;

export const TargetApps = t.record(UUID, TargetApp);
export type TargetApps = t.TypeOf<typeof TargetApps>;

/**
 * A device has a name, config and collection of apps
 */
const TargetDevice = t.type({
	name: DeviceName,
	config: ConfigVarObject,
	apps: TargetApps,
});
export type TargetDevice = t.TypeOf<typeof TargetDevice>;

/**
 * Target state is a collection of devices one local device
 * (with uuid matching the one in config.json)
 *
 *
 * When all io-ts types are composed, the final type of the target state
 * is the one given by the following description
 * ```
 * {
 *  [uuid: string]: {
 *    name: string;
 *    config?: {
 *      [varName: string]: string;
 *    };
 *    apps: {
 *      [uuid: string]: {
 *        // @deprecated to be removed in state v4
 *        id: number;
 *        name: string;
 *        class: 'fleet' | 'block' | 'app';
 *        parent_app?: string;
 *        is_host?: boolean;
 *        releases?: {
 *          [uuid: string]: {
 *            // @deprecated to be removed in state v4
 *            id: number;
 *            services?: {
 *              [name: string]: {
 *                // @deprecated to be removed in state v4
 *                id: number;
 *                // @deprecated to be removed in state v4
 *                image_id: number;
 *                image: string;
 *                // defaults to true if undefined
 *                running?: boolean;
 *                environment: {
 *                  [varName: string]: string;
 *                };
 *                labels: {
 *                  [labelName: string]: string;
 *                };
 *                contract?: AnyObject;
 *                composition?: ServiceComposition;
 *              };
 *            };
 *            volumes?: AnyObject;
 *            networks?: AnyObject;
 *          };
 *        };
 *      };
 *    };
 *  };
 * }
 * ```
 */
export const TargetState = t.record(UUID, TargetDevice);
export type TargetState = t.TypeOf<typeof TargetState>;

const TargetAppWithRelease = t.intersection([
	TargetApp,
	t.type({ releases: nonEmptyRecord(UUID, TargetRelease) }),
]);

export const AppsJsonFormat = t.intersection([
	t.type({
		config: withDefault(ConfigVarObject, {}),
		apps: withDefault(t.record(UUID, TargetAppWithRelease), {}),
	}),
	t.partial({ pinDevice: t.boolean }),
]);
export type AppsJsonFormat = t.TypeOf<typeof AppsJsonFormat>;
