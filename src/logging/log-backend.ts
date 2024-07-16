type BaseLogMessage = {
	message: string;
	isStdErr?: boolean;
	timestamp?: number;
};
export type LogMessage = BaseLogMessage &
	(
		| {
				serviceId?: number;
				imageId?: number;
				isSystem?: false;
		  }
		| {
				message: string;
				isSystem: true;
		  }
	);

export abstract class LogBackend {
	public unmanaged: boolean;
	public publishEnabled: boolean = true;

	public abstract log(getMessage: () => LogMessage | undefined): void;
}

export default LogBackend;
