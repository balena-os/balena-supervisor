import 'dockerode';

declare module 'dockerode' {
	interface HostConfig {
		// Requires Engine API v1.43+, missing from @types/dockerode
		Annotations?: { [key: string]: string };
	}
}
