import { Network } from '../compose/network';
import { Service } from '../compose/service';
import { ComposeVolume } from '../compose/volumes';

import ServiceManager from '../compose/service-manager';

export class Application {
	public appId: number;
	// Was this application created from the current state?
	public isCurrent: boolean;

	private serviceManager: ServiceManager;

	private constructor() {}

	public newFromTarget(): Application {}

	public newFromCurrent(): Application {}

	public getUpdateSteps(): UpdateStep[] {}
}

export default Application;
