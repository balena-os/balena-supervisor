export type BaseLogMessage = {
	message: string;
	isStdErr?: boolean;
	timestamp: number;
};
export type SystemLogMessage = BaseLogMessage & {
	isSystem: true;
};
type ContainerLogMessage = BaseLogMessage & {
	serviceId: number;
	isSystem?: false;
};
export type LogMessage = SystemLogMessage | ContainerLogMessage;
