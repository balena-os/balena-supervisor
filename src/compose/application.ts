import ServiceManager from './service-manager';
import Volumes from './volumes';
import Networks from './network-manager';

export class Application {
	public appId: number;
	// Was this application created from the current state?
	public isCurrent: boolean;

	private serviceManager: ServiceManager;
	private volumeManager: Volumes;
	private networkManger: Networks;

	private constructor() {}

	public newFromTarget(): Application {}
}

export default Application;
