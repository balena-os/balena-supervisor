import type { LogMessage } from './types';

export abstract class LogBackend {
	public unmanaged: boolean;
	public publishEnabled: boolean = true;

	public abstract log(message: LogMessage): Promise<void>;
}

export default LogBackend;
