import * as TransportStream from 'winston-transport';

export default class LogBuffer extends TransportStream {
	private buffer: string[];
	private maxSize: number;
	private size: number;

	constructor(opts?: TransportStream.TransportStreamOptions) {
		super(opts);

		this.buffer = [];
		this.maxSize = 1e6;
		this.size = 0;
	}

	log(info: any, next: () => void): any {
		if (['docker'].includes(info.level)) {
			this.buffer.push(info.message);
			this.size += info.message.length;
		}

		while (this.size > this.maxSize && this.buffer.length) {
			this.size -= this.buffer.shift()?.length ?? 0;
		}

		next();
	}

	public dump(): string[] {
		return this.buffer;
	}
}
