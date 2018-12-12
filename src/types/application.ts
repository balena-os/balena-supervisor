import { ServiceComposeConfig } from '../compose/types/service';

export class Application {
	public appId: number;
	public commit: string;
	public name: string;
	public releaseId: number;
	public networks: Dictionary<any>;
	public volumes: Dictionary<any>;

	public services: Dictionary<ServiceComposeConfig>;
}
