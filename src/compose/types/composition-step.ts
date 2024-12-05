import type { Image } from './image';
import type { Service } from './service';
import type { Network } from './network';
import type { Volume } from './volume';
import type { Lock } from '../../lib/update-lock';

export interface CompositionStepArgs {
	stop: {
		current: Service;
		options?: {
			wait?: boolean;
		};
	};
	kill: {
		current: Service;
		options?: {
			wait?: boolean;
		};
	};
	remove: {
		current: Service;
	};
	updateMetadata: {
		current: Service;
		target: Service;
	};
	restart: {
		current: Service;
		target: Service;
	};
	start: {
		target: Service;
	};
	updateCommit: {
		target: string;
		appId: number;
	};
	handover: {
		current: Service;
		target: Service;
		options?: {
			timeout?: number;
		};
	};
	fetch: {
		image: Image;
		serviceName: string;
	};
	removeImage: {
		image: Image;
	};
	saveImage: {
		image: Image;
	};
	cleanup: object;
	createNetwork: {
		target: Network;
	};
	createVolume: {
		target: Volume;
	};
	removeNetwork: {
		current: Network;
	};
	removeVolume: {
		current: Volume;
	};
	ensureSupervisorNetwork: object;
	noop: object;
	takeLock: {
		appId: string | number;
		services: string[];
		force: boolean;
	};
	releaseLock: {
		appId: string | number;
		lock: Lock | null;
	};
	requireReboot: { serviceName: string };
}

export type CompositionStepAction = keyof CompositionStepArgs;
export type CompositionStepT<T extends CompositionStepAction> = {
	action: T;
} & CompositionStepArgs[T];
export type CompositionStep = CompositionStepT<CompositionStepAction>;
