import * as _ from 'lodash';
import { TransformableInfo } from 'logform';
import * as winston from 'winston';

const levels = {
	error: 0,
	warn: 1,
	success: 2,
	event: 3,
	api: 4,
	info: 5,
	debug: 6,
};

type logLevel = keyof typeof levels;

const colors: { [key in logLevel]: string | string[] } = {
	error: 'red',
	warn: 'yellow',
	success: 'green',
	event: 'cyan',
	info: 'blue',
	debug: 'magenta',
	api: ['black', 'bgWhite'],
};

const maxLevelLength = _(levels)
	.map((_v, k) => k.length)
	.max();

const uncolorize = winston.format.uncolorize();

const formatter = winston.format.printf((args) => {
	const { level, message } = args;
	const { level: strippedLevel } = uncolorize.transform(args, {
		level: true,
		message: true,
	}) as TransformableInfo;
	return `[${level}]${_.repeat(
		' ',
		maxLevelLength! - strippedLevel.length + 1,
	)}${message}`;
});

export const winstonLog = winston.createLogger({
	format: winston.format.combine(winston.format.colorize(), formatter),
	transports: [new winston.transports.Console()],
	// In the future we can reduce this logging level in
	// certain scenarios, but for now we don't want to ignore
	// any debugging without a rock solid method of making
	// sure that debug logs are shown. For example a switch on
	// the dashboard, a supervisor api call and supervisor
	// process crash detection
	level: 'debug',
	levels,
	// A bit hacky to get all the correct types for the logger
	// below, we first cast to unknown so we can do what we
	// like, and then assign every log level a function (which
	// is what happens internally in winston)
}) as unknown as { [key in logLevel]: (message: string) => void };

winston.addColors(colors);

const messageFormatter = (printFn: (message: string) => void) => {
	return (...parts: any[]) => {
		parts
			.map((p) => {
				if (p instanceof Error) {
					return p.stack;
				}
				return p;
			})
			.join(' ')
			.replace('\n', '\n  ')
			.split('\n')
			.forEach(printFn);
	};
};

export const log: { [key in logLevel]: (...messageParts: any[]) => void } = {
	error: messageFormatter(winstonLog.error),
	warn: messageFormatter(winstonLog.warn),
	success: messageFormatter(winstonLog.success),
	event: messageFormatter(winstonLog.event),
	info: messageFormatter(winstonLog.info),
	debug: messageFormatter(winstonLog.debug),
	api: messageFormatter(winstonLog.api),
};

export default log;
