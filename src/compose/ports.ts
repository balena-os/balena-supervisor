import * as _ from 'lodash';
import TypedError = require('typed-error');

// Adapted from https://github.com/docker/docker-py/blob/master/docker/utils/ports.py#L3
const PORTS_REGEX =
	/^(?:(?:([a-fA-F\d.:]+):)?([\d]*)(?:-([\d]+))?:)?([\d]+)(?:-([\d]+))?(?:\/(udp|tcp))?$/;

export class InvalidPortDefinition extends TypedError { }

export interface PortBindings {
	[key: string]: Array<{ HostIp: string, HostPort: string }>;
}

export interface DockerPortOptions {
	exposedPorts: Map<string, {}>;
	portBindings: PortBindings;
}

export class PortMap {

	private internalStart: number;
	private internalEnd: number;
	private externalStart: number;
	private externalEnd: number;
	private protocol: string;
	private host: string;

	public constructor(portStr: string) {
		this.parsePortString(portStr);
	}

	public toDockerOpts(): DockerPortOptions {
		const internalRange = this.generatePortRange(this.internalStart, this.internalEnd);
		const externalRange = this.generatePortRange(this.externalStart, this.externalEnd);

		const exposed: { [key: string]: {} } = {};
		const portBindings: PortBindings = {};

		_.zipWith(internalRange, externalRange, (internal, external) => {
			exposed[`${internal}/${this.protocol}`] = {};

			portBindings[`${internal}/${this.protocol}`] = [
				{ HostIp: this.host, HostPort: external!.toString() },
			];
		});

		return {
			exposedPorts: exposed,
			portBindings,
		};
	}

	private parsePortString(portStr: string): void {
		const match = portStr.match(PORTS_REGEX);
		if (match == null) {
			throw new InvalidPortDefinition(`Could not parse port definition: ${portStr}`);
		}

		let [
			,
			host = '',
			external,
			externalEnd,
			internal,
			internalEnd,
			protocol = 'tcp',
		] = match;

		if (external == null) {
			external = internal;
		}

		if (internalEnd == null) {
			internalEnd = internal;
		}

		if (externalEnd == null) {
			if (internal === internalEnd) {
				// This is a special case to handle a:b
				externalEnd = external;
			} else {
				// and this handles a-b
				externalEnd = internalEnd;
			}
		}

		this.internalStart = parseInt(internal, 10);
		this.internalEnd = parseInt(internalEnd, 10);
		this.externalStart = parseInt(external, 10);
		this.externalEnd = parseInt(externalEnd, 10);
		this.host = host;
		this.protocol = protocol;

		// Ensure we have the same range
		if (this.internalEnd - this.internalStart !== this.externalEnd - this.externalStart) {
			throw new InvalidPortDefinition(
				`Range for internal and external ports does not match: ${portStr}`,
			);
		}
	}

	private generatePortRange(start: number, end: number): number[] {
		if (start > end) {
			throw new Error('Incorrect port range! The end port cannot be larger than the start port!');
		}
		if (start === end) {
			return [ start ];
		}

		return _.range(start, end + 1);
	}
}
