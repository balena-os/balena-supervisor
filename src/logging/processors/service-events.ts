import { logBuffer } from '../../lib/supervisor-console';
import { Processor } from './processor';

interface ServiceEvent {
	service: string;
	event: string;
	timestamp: number;
}

class ServiceEvents extends Processor {
	public process(logs = logBuffer.dump()): ServiceEvent[] {
		return logs.map((l: string) => {
			// Trim the log level included at the beginning of each log
			const logObjectString = l.substring(8);
			// Parse log string into JSON
			const logJson = JSON.parse(logObjectString);
			// Return object of values we want
			return {
				service: logJson['Actor']['Attributes']['io.balena.service-name'],
				event: logJson['Action'],
				timestamp: parseInt(logJson['time'], 10) * 1000,
			} as ServiceEvent;
		});
	}
}

export default new ServiceEvents();
