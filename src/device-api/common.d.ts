import { Service } from '../compose/service';
import { InstancedDeviceState } from '../types/state';

export interface ServiceAction {
	action: string;
	serviceId: number;
	current: Service;
	target: Service;
	options: any;
}

declare function doRestart(appId: number, force: boolean): Promise<void>;

declare function doPurge(appId: number, force: boolean): Promise<void>;

declare function serviceAction(
	action: string,
	serviceId: number,
	current: Service,
	target?: Service,
	options?: any,
): ServiceAction;

declare function safeStateClone(
	targetState: InstancedDeviceState,
): // Use an any here, because it's not an InstancedDeviceState,
// and it's also not the exact same type as the API serves from
// state endpoint (more details in the function)
Dictionary<any>;
