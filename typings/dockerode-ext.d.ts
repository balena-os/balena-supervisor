export { ContainerInspectInfo } from 'dockerode';

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
}
