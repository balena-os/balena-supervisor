import type { Network } from './network';
import type { Volume } from './volume';
import type { Service } from './service';
import type { LocksTakenMap } from '../../lib/update-lock';
import type { Image } from './image';
import type { CompositionStep } from './composition-step';

export interface UpdateState {
	availableImages: Image[];
	containerIds: Dictionary<string>;
	downloading: string[];
	locksTaken: LocksTakenMap;
	force: boolean;
}

export interface App {
	appId: number;
	appUuid?: string;
	// When setting up an application from current state, these values are not available
	appName?: string;
	commit?: string;
	source?: string;
	isHost?: boolean;
	// Services are stored as an array, as at any one time we could have more than one
	// service for a single service ID running (for example handover)
	services: Service[];
	networks: Network[];
	volumes: Volume[];

	nextStepsForAppUpdate(state: UpdateState, target: App): CompositionStep[];
	stepsToRemoveApp(
		state: Omit<UpdateState, 'availableImages'> & { keepVolumes: boolean },
	): CompositionStep[];
}

export interface AppsToLockMap {
	[appId: number]: Set<string>;
}
