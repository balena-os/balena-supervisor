import { Image } from '../compose/images';
import { Network } from '../compose/network';
import { Service } from '../compose/service';
import Volume from '../compose/volume';

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
		image: Image;
	};
	removeImage: {
		image: Image;
	};
	saveImage: {
		image: Image;
	};
	cleanup: {};
	createNetworkOrVolume:
		| {
				model: 'network';
				target: Network;
		  }
		| {
				model: 'volume';
				target: Volume;
		  };
	removeNetworkOrVolume:
		| {
				model: 'network';
				current: Network;
				appId: number;
		  }
		| {
				model: 'volume';
				current: Volume;
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
