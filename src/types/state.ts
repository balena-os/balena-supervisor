import * as t from 'io-ts';

// TODO: move all these exported types to ../compose/types
import { ComposeNetworkConfig } from '../compose/types/network';
import { ServiceComposeConfig } from '../compose/types/service';
import { ComposeVolumeConfig } from '../compose/volume';

import {
	DockerName,
	EnvVarObject,
	LabelObject,
	StringIdentifier,
	NumericIdentifier,
	ShortString,
	DeviceName,
} from './basic';

import App from '../compose/app';

export type DeviceReportFields = Partial<{
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
	is_on__commit: string;
	logs_channel: null;
	mac_address: string | null;
}>;

// This is the state that is sent to the cloud
export interface DeviceStatus {
	local?: {
		config?: Dictionary<string>;
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
	} & DeviceReportFields;
	// TODO: Type the dependent entry correctly
	dependent?: {
		[key: string]: any;
	};
	commit?: string;
}

// Return a type with a default value
const withDefault = <T extends t.Any>(
	type: T,
	defaultValue: t.TypeOf<T>,
): t.Type<t.TypeOf<T>> =>
	new t.Type(
		type.name,
		type.is,
		(v, c) => type.validate(!!v ? v : defaultValue, c),
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

export const TargetService = t.intersection([
	t.type({
		serviceName: DockerName,
		imageId: NumericIdentifier,
		image: ShortString,
		environment: EnvVarObject,
		labels: LabelObject,
	}),
	t.partial({
		running: withDefault(t.boolean, true),
		contract: t.record(t.string, t.unknown),
	}),
	// This will not be validated
	// TODO: convert ServiceComposeConfig to a io-ts type
	fromType<ServiceComposeConfig>('ServiceComposition'),
]);
export type TargetService = t.TypeOf<typeof TargetService>;

const TargetApp = t.intersection(
	[
		t.type({
			name: ShortString,
			services: withDefault(t.record(StringIdentifier, TargetService), {}),
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
		}),
		t.partial({
			commit: ShortString,
			releaseId: NumericIdentifier,
		}),
	],
	'App',
);
export type TargetApp = t.TypeOf<typeof TargetApp>;

export const TargetApps = t.record(StringIdentifier, TargetApp);
export type TargetApps = t.TypeOf<typeof TargetApps>;

const DependentApp = t.intersection(
	[
		t.type({
			name: ShortString,
			parentApp: NumericIdentifier,
			config: EnvVarObject,
		}),
		t.partial({
			releaseId: NumericIdentifier,
			imageId: NumericIdentifier,
			commit: ShortString,
			image: ShortString,
		}),
	],
	'DependentApp',
);

const DependentDevice = t.type(
	{
		name: ShortString, // device uuid
		apps: t.record(
			StringIdentifier,
			t.type({ config: EnvVarObject, environment: EnvVarObject }),
		),
	},
	'DependentDevice',
);

// Although the original types for dependent apps and dependent devices was a dictionary,
// proxyvisor.js accepts both a dictionary and an array. Unfortunately
// the CLI sends an array, thus the types need to accept both
const DependentApps = t.union([
	t.array(DependentApp),
	t.record(StringIdentifier, DependentApp),
]);

const DependentDevices = t.union([
	t.array(DependentDevice),
	t.record(StringIdentifier, DependentDevice),
]);

export const TargetState = t.type({
	local: t.type({
		name: DeviceName,
		config: EnvVarObject,
		apps: TargetApps,
	}),
	dependent: t.type({
		apps: DependentApps,
		devices: DependentDevices,
	}),
});
export type TargetState = t.TypeOf<typeof TargetState>;

const TargetAppWithRelease = t.intersection([
	TargetApp,
	t.type({ commit: t.string, releaseId: NumericIdentifier }),
]);

const AppsJsonFormat = t.intersection([
	t.type({
		config: EnvVarObject,
		apps: t.record(StringIdentifier, TargetAppWithRelease),
	}),
	t.partial({ pinDevice: t.boolean }),
]);
export type AppsJsonFormat = t.TypeOf<typeof AppsJsonFormat>;

export type InstancedAppState = { [appId: number]: App };

export interface InstancedDeviceState {
	local: {
		name: string;
		config: Dictionary<string>;
		apps: InstancedAppState;
	};
	dependent: any;
}
