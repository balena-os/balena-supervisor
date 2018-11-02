export type LogMessage = Dictionary<any>;

export abstract class LogBackend {
	public offlineMode: boolean;
	public publishEnabled: boolean = true;

	public abstract log(message: LogMessage): void;
}

export default LogBackend;
