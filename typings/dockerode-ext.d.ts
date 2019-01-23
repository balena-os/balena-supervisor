import { ContainerInspectInfo } from 'dockerode';

declare module 'dockerode' {
	// Extend the HostConfig interface with the missing fields.
	// TODO: Add these upstream to DefinitelyTyped
	interface HostConfig {
		Sysctls: { [sysctlsOpt: string]: string };
		GroupAdd: string[];
		UsernsMode: string;
	}

	export interface DockerHealthcheck {
		Test: string[];
		Interval?: number;
		Timeout?: number;
		Retries?: number;
		StartPeriod?: number;
	}

	interface ContainerCreateOptions {
		Healthcheck?: DockerHealthcheck;
		StopTimeout?: number;
	}

	// TODO: Once https://github.com/DefinitelyTyped/DefinitelyTyped/pull/32383
	// is merged and released, remove this and VolumeInfoList
	export interface VolumeInspectInfo {
		Name: string;
		Driver: string;
		Mountpoint: string;
		Status?: { [key: string]: string };
		Labels: { [key: string]: string };
		Scope: 'local' | 'global';
		// Field is always present, but sometimes is null
		Options: { [key: string]: string } | null;
		// Field is sometimes present, and sometimes null
		UsageData?: {
			Size: number;
			RefCount: number;
		} | null;
	}

	export interface VolumeInfoList {
		Volumes: Dockerode.VolumeInspectInfo[];
		Warnings: string[];
	}
}
