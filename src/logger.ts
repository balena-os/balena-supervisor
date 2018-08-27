import * as Bluebird from 'bluebird';
import * as es from 'event-stream';
import { ClientRequest } from 'http';
import * as https from 'https';
import * as _ from 'lodash';
import * as Lock from 'rwlock';
import * as stream from 'stream';
import * as url from 'url';
import * as zlib from 'zlib';

import { EventTracker } from './event-tracker';
import Docker = require('./lib/docker-utils');
import { LogType } from './lib/log-types';

const ZLIB_TIMEOUT = 100;
const COOLDOWN_PERIOD = 5 * 1000;
const KEEPALIVE_TIMEOUT = 60 * 1000;
const RESPONSE_GRACE_PERIOD = 5 * 1000;

const MAX_LOG_LENGTH = 10 * 1000;
const MAX_PENDING_BYTES = 256 * 1024;

interface Options extends url.UrlWithParsedQuery {
	method: string;
	headers: Dictionary<string>;
}

type LogMessage = Dictionary<any>;

abstract class LogBackend {
	public offlineMode: boolean;
	public publishEnabled: boolean = true;

	public abstract log(message: LogMessage): void;
}

class ResinLogBackend extends LogBackend {

	private req: ClientRequest | null = null;
	private dropCount: number = 0;
	private writable: boolean = true;
	private gzip: zlib.Gzip | null = null;
	private opts: Options;
	private stream: stream.PassThrough;
	timeout: NodeJS.Timer;

	public constructor(
		apiEndpoint: string,
		uuid: string,
		deviceApiKey: string,
	) {
		super();

		this.opts = url.parse(`${apiEndpoint}/device/v2/${uuid}/log-stream`) as any;
		this.opts.method = 'POST';
		this.opts.headers = {
			Authorization: `Bearer ${deviceApiKey}`,
			'Content-Type': 'application/x-ndjson',
			'Content-Encoding': 'gzip',
		};

		// This stream serves serves as a message buffer during reconnections
		// while we unpipe the old, malfunctioning connection and then repipe a
		// new one.
		this.stream = new stream.PassThrough({
			allowHalfOpen: true,

			// We halve the high watermark because a passthrough stream has two
			// buffers, one for the writable and one for the readable side. The
			// write() call only returns false when both buffers are full.
			highWaterMark: MAX_PENDING_BYTES / 2,
		});

		this.stream.on('drain', () => {
			this.writable = true;
			this.flush();
			if (this.dropCount > 0) {
				this.write({
					message: `Warning: Suppressed ${this.dropCount} message(s) due to high load`,
					timestamp: Date.now(),
					isSystem: true,
					isStdErr: true,
				});
				this.dropCount = 0;
			}
		});
	}

	public log(message: LogMessage) {
		if (this.offlineMode || !this.publishEnabled) {
			return;
		}

		if (!_.isObject(message)) {
			return;
		}

		message = _.assign({
			timestamp: Date.now(),
			message: '',
		}, message);

		if (!message.isSystem && message.serviceId == null) {
			return;
		}

		message.message = _.truncate(message.message, {
			length: MAX_LOG_LENGTH,
			omission: '[...]',
		});

		this.write(message);
	}

	private setup = _.throttle(() => {
		this.req = https.request(this.opts);

		// Since we haven't sent the request body yet, and never will,the
		// only reason for the server to prematurely respond is to
		// communicate an error. So teardown the connection immediately
		this.req.on('response', (res) => {
			console.log('LogBackend: server responded with status code:', res.statusCode);
			this.teardown();
		});

		this.req.on('timeout', () => this.teardown());
		this.req.on('close', () => this.teardown());
		this.req.on('error', (err) => {
			console.log('LogBackend: unexpected error:', err);
			this.teardown();
		});

		// Immediately flush the headers. This gives a chance to the server to
		// respond with potential errors such as 401 authentication error
		this.req.flushHeaders();


		// We want a very low writable high watermark to prevent having many
		// chunks stored in the writable queue of @_gzip and have them in
		// @_stream instead. This is desirable because once @_gzip.flush() is
		// called it will do all pending writes with that flush flag. This is
		// not what we want though. If there are 100 items in the queue we want
		// to write all of them with Z_NO_FLUSH and only afterwards do a
		// Z_SYNC_FLUSH to maximize compression
		this.gzip = zlib.createGzip({ writableHighWaterMark: 1024 });
		this.gzip.on('error', () => this.teardown());
		this.gzip.pipe(this.req);

		// Only start piping if there has been no error after the header flush.
		// Doing it immediately would potentialy lose logs if it turned out that
		// the server is unavailalbe because @_req stream would consume our
		// passthrough buffer
		this.timeout = setTimeout(() => {
			if (this.gzip != null) {
				this.stream.pipe(this.gzip);
				this.flush();
			}
		}, RESPONSE_GRACE_PERIOD);

	}, COOLDOWN_PERIOD);

	private snooze = _.debounce(this.teardown, KEEPALIVE_TIMEOUT);

	// Flushing every ZLIB_TIMEOUT hits a balance between compression and
	// latency. When ZLIB_TIMEOUT is 0 the compression ratio is around 5x
	// whereas when ZLIB_TIMEOUT is infinity the compession ratio is around 10x.
	private flush = _.throttle(() => {
		if (this.gzip != null) {
			this.gzip.flush(zlib.Z_SYNC_FLUSH);
		}
	}, ZLIB_TIMEOUT, { leading: false });

	private teardown() {
		if (this.req != null) {
			clearTimeout(this.timeout);
			this.req.removeAllListeners();
			this.req.on('error', _.noop);
			if (this.gzip != null) {
				this.stream.unpipe(this.gzip);
				this.gzip.end();
			}
			this.req = null;
		}
	}

	private write(message: LogMessage) {
		this.snooze();
		if (this.req == null) {
			this.setup();
		}

		if (this.writable) {
			this.writable = this.stream.write(JSON.stringify(message) + '\n');
			this.flush();
		} else {
			this.dropCount += 1;
		}
	}
}

interface LoggerConstructOptions {
	eventTracker: EventTracker;
}

interface LoggerSetupOptions {
	apiEndpoint: string;
	uuid: string;
	deviceApiKey: string;
	offlineMode: boolean;
	enableLogs: boolean;
}

type LogEventObject = Dictionary<any> | null;

enum OutputStream {
	Stdout,
	Stderr,
}

export class Logger {
	private writeLock: (key: string) => Bluebird<() => void> = Bluebird.promisify(
		new Lock().async.writeLock,
	);
	private backend: LogBackend | null = null;
	private eventTracker: EventTracker;
	private attached: {
		[key in OutputStream]: { [containerId: string]: boolean }
	} = {
		[OutputStream.Stderr]: { },
		[OutputStream.Stdout]: { },
	};

	public constructor({ eventTracker }: LoggerConstructOptions) {
		this.backend = null;
		this.eventTracker = eventTracker;
	}

	public init({
		apiEndpoint,
		uuid,
		deviceApiKey,
		offlineMode,
		enableLogs,
	}: LoggerSetupOptions,
	) {
		this.backend = new ResinLogBackend(apiEndpoint, uuid, deviceApiKey);
		this.backend.offlineMode = offlineMode;
	}

	public enable(value: boolean = true) {
		if (this.backend != null) {
			this.backend.publishEnabled = value;
		}
	}

	public logDependent(message: LogMessage, device: { uuid: string }) {
		if (this.backend != null) {
			message.uuid = device.uuid;
			this.backend.log(message);
		}
	}

	public log(message: LogMessage) {
		if (this.backend != null) {
			this.backend.log(message);
		}
	}

	public logSystemMessage(
		message: string,
		eventObj?: LogEventObject,
		eventName?: string,
	) {
		const msgObj: LogMessage = { message, isSystem: true };
		if (eventObj != null && eventObj.error != null) {
			msgObj.isStdErr = true;
		}
		this.log(msgObj);
		this.eventTracker.track(
			eventName != null ? eventName : message,
			eventObj != null ? eventObj : { },
		);
	}

	public lock(containerId: string): Bluebird.Disposer<() => void> {
		return this.writeLock(containerId)
			.disposer((release) => {
				release();
			});
	}

	public attach(
		docker: Docker,
		containerId: string,
		serviceInfo: { serviceId: string, imageId: string },
	): Bluebird<void> {
		return Bluebird.using(this.lock(containerId), () => {
			return this.attachStream(docker, OutputStream.Stdout, containerId, serviceInfo)
				.then(() => {
					return this.attachStream(docker, OutputStream.Stderr, containerId, serviceInfo);
				});
		});
	}

	public logSystemEvent(logType: LogType, obj: LogEventObject): void {
		let message = logType.humanName;
		const objectName = this.objectNameForLogs(obj);
		if (objectName != null) {
			message += ` '${objectName}'`;
		}
		if (obj && obj.error != null) {
			let errorMessage = obj.error.message;
			if (_.isEmpty(errorMessage)) {
				errorMessage = 'Unknown cause';
				console.error('Warning: invalid error message', obj.error);
			}
			message += ` due to '${errorMessage}'`;
		}
		this.logSystemMessage(message, obj, logType.eventName);
	}

	public logConfigChange(
		config: { [configName: string]: string },
		{ success = false, err = null }: { success?: boolean, err?: Error } = { },
	) {
		const obj: LogEventObject = { config };
		let message: string;
		let eventName: string;
		if (success) {
			message = `Applied configuration change ${JSON.stringify(config)}`;
			eventName = 'Apply config change success';
		} else if(err != null) {
			message = `Error applying configuration change: ${err}`;
			eventName = 'Apply config change error';
			obj.error = err;
		} else {
			message = `Applying configuration change #{JSON.stringify(config)}`;
			eventName = 'Apply config change in progress';
		}

		this.logSystemMessage(message, obj, eventName);
	}

	// TODO: This function interacts with the docker daemon directly,
	// using the container id, but it would be better if this was provided
	// by the Compose/Service-Manager module, as an accessor
	private attachStream(
		docker: Docker,
		streamType: OutputStream,
		containerId: string,
		{ serviceId, imageId }: { serviceId: string, imageId: string},
	): Bluebird<void> {

			return Bluebird.try(() => {
				if (this.attached[streamType][containerId]) {
					return;
				}

				const logsOpts = {
					follow: true,
					stdout: streamType === OutputStream.Stdout,
					stderr: streamType === OutputStream.Stderr,
					timestamps: true,
					since: Math.floor(Date.now() / 1000),
				};

				return docker.getContainer(containerId).logs(logsOpts)
					.then((stream) => {
						this.attached[streamType][containerId] = true;

						stream
						.on('error', (err) => {
							console.error('Error on container logs', err);
							this.attached[streamType][containerId] = false;
						})
						.pipe(es.split())
						.on('data', (logBuf: Buffer) => {
							const logLine = logBuf.toString();
							const space = logLine.indexOf(' ');
							if (space > 0) {
								const message: LogMessage = {
									timestamp: (new Date(logLine.substr(0, space))).getTime(),
									message: logLine.substr(space + 1),
									serviceId,
									imageId,
								};
								if (streamType === OutputStream.Stderr) {
									message.isStdErr = true;
								}
								this.log(message);
							}
						})
						.on('error', (err) => {
							console.error('Error on container logs', err);
							this.attached[streamType][containerId] = false;
						})
						.on('end', () => {
							this.attached[streamType][containerId] = false;
						});
					});

			});

	}

	private objectNameForLogs(eventObj: LogEventObject): string | null {
		if (eventObj == null) {
			return null;
		}
		if (eventObj.service != null &&
			eventObj.service.serviceName != null &&
			eventObj.service.image != null
		) {
			return `${eventObj.service.serviceName} ${eventObj.service.image}`;
		}

		if (eventObj.image != null) {
			return eventObj.image.name;
		}

		if (eventObj.network != null && eventObj.network.name != null) {
			return eventObj.network.name;
		}

		if (eventObj.volume != null && eventObj.volume.name != null) {
			return eventObj.volume.name;
		}

		return null;
	}
}
