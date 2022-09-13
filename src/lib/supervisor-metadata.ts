export type SupervisorMetadata = {
	uuid: string;
	serviceName: string;
};

/**
 * Although it might feel unsettling to hardcode these ids here.
 * the main purpose of app uuids is to have environment independent
 * apps. These ids will be the same in balena-cloud.com and balena-staging.com
 * and they should be the same in open-balena instances for target state
 * v3 to work with those instances.
 *
 * This will only be necessary until the supervisor becomes an actual app
 * on balena
 */
const SUPERVISOR_APPS: { [arch: string]: SupervisorMetadata } = {
	amd64: {
		uuid: '52e35121417640b1b28a680504e4039b',
		serviceName: 'balena-supervisor',
	},
	aarch64: {
		uuid: '900de4f3cbac4b9bbd232885a35e407b',
		serviceName: 'balena-supervisor',
	},
	armv7hf: {
		uuid: '2e66a95795c149959c69472a8c2f92b8',
		serviceName: 'balena-supervisor',
	},
	i386: {
		uuid: '531b357e155c480cbec0fdd33041a1f5',
		serviceName: 'balena-supervisor',
	},
	rpi: {
		uuid: '6822565f766e413e96d9bebe2227cdcc',
		serviceName: 'balena-supervisor',
	},
};

/**
 * Check if the supervisor in the target state belongs to the known
 * supervisors
 *
 * This is needed for the supervisor to identify itself on the target
 * state and on getStatus() in device-state.ts
 *
 * TODO: remove this once the supervisor knows how to update itself
 */

export const isSupervisor = (appUuid: string, svcName: string) => {
	return (
		Object.values(SUPERVISOR_APPS).filter(
			({ uuid, serviceName }) =>
				// Compare with `main` as well for compatibility with older supervisors
				appUuid === uuid && (svcName === serviceName || svcName === 'main'),
		).length > 0
	);
};
