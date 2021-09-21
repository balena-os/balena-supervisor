import * as memoizee from 'memoizee';
import * as config from '../config';
import { InternalInconsistencyError } from './errors';

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
 * Get the metadata from the supervisor container
 *
 * This is needed for the supervisor to identify itself on the target
 * state and on getStatus() in device-state.ts
 *
 * TODO: remove this once the supervisor knows how to update itself
 */
export const getSupervisorMetadata = memoizee(
	async () => {
		const deviceArch = await config.get('deviceArch');
		const meta: SupervisorMetadata = SUPERVISOR_APPS[deviceArch];
		if (meta == null) {
			throw new InternalInconsistencyError(
				`Unknown device architecture ${deviceArch}. Could not find matching supervisor metadata.`,
			);
		}

		return meta;
	},
	{ promise: true },
);
