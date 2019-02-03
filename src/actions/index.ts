import { Service } from '../compose/service';
import { NetworkConfig } from '../compose/types/network';
import { VolumeCreateOpts, VolumeNameOpts } from '../compose/volumes';

export interface ServiceImage {
	name: string;
	appId: number;
	serviceId: number;
	serviceName: string;
	imageId: number;
	releaseId: number;
	dependent: number;
}

export interface ActionOptions {
	skipLock?: boolean;
	wait?: boolean;
	force?: boolean;
	removeImage?: boolean;
}

interface ActionExecutorTypes {
	stop: {
		current: Service;
	};
	kill: {
		current: Service;
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
	stopAll: {};
	start: {
		target: Service;
	};
	updateCommit: {
		target: string;
	};
	handover: {
		current: Service;
		target: Service;
	};
	fetch: {
		image: ServiceImage;
	};
	removeImage: {
		image: ServiceImage;
	};
	saveImage: {
		image: ServiceImage;
	};
	cleanup: {};
	createNetworkOrVolume:
		| {
				model: 'network';
				target: { name: string; config: NetworkConfig };
				appId: number;
		  }
		| {
				model: 'volume';
				target: VolumeCreateOpts;
		  };
	removeNetworkOrVolume:
		| {
				model: 'network';
				current: { name: string; config: NetworkConfig };
				appId: number;
		  }
		| {
				model: 'volume';
				current: VolumeNameOpts;
		  };
	ensureSupervisorNetwork: {};
	noop: {};
}

export type ActionExecutorKeys = keyof ActionExecutorTypes;

export type ActionExecutorStepT<T extends ActionExecutorKeys> = {
	action: T;
	options?: ActionOptions;
} & ActionExecutorTypes[T];

export type ActionExecutorStep = ActionExecutorStepT<ActionExecutorKeys>;

type ActionExecutorsT<T extends ActionExecutorKeys> = {
	[key in T]: (
		step: ActionExecutorStepT<key>,
		opts: ActionOptions,
	) => Promise<void>
};

export type ActionExecutors = ActionExecutorsT<ActionExecutorKeys>;
