import ApplicationManager from '../application-manager';
import { Service } from '../compose/service';
import { ActionExecutorStep } from '../actions';

declare function doRestart(
	applications: ApplicationManager,
	appId: number,
	force: boolean,
): Promise<void>;

declare function doPurge(
	applications: ApplicationManager,
	appId: number,
	force: boolean,
): Promise<void>;

declare function serviceAction(
	action: string,
	serviceId: number,
	current: Service,
	target?: Service,
	options?: any,
): ActionExecutorStep;
