type BaseLogMessage = {
	message: string;
	isStdErr?: boolean;
	timestamp: number;
};
export type LogMessage = BaseLogMessage &
	(
		| {
				serviceId: number;
				isSystem?: false;
		  }
		| {
				isSystem: true;
		  }
	);

export abstract class LogBackend {
	public unmanaged: boolean;
	public publishEnabled: boolean = true;

	public abstract log(message: LogMessage): Promise<void>;
}

export default LogBackend;
