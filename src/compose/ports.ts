import _ from 'lodash';
import { TypedError } from 'typed-error';

// Adapted from https://github.com/docker/docker-py/blob/master/docker/utils/ports.py#L3
const PORTS_REGEX =
	/^(?:(?:([a-fA-F\d.:]+):)?([\d]*)(?:-([\d]+))?:)?([\d]+)(?:-([\d]+))?(?:\/(udp|tcp))?$/;

// A regex to extract the protocol and internal port of the incoming Docker options
const DOCKER_OPTS_PORTS_REGEX = /(\d+)(?:\/?([a-z]+))?/i;

export class InvalidPortDefinition extends TypedError {}

export interface PortBindings {
	[key: string]: Array<{ HostIp: string; HostPort: string }>;
}

export interface DockerPortOptions {
	exposedPorts: Dictionary<EmptyObject>;
	portBindings: PortBindings;
}

export interface PortRange {
	internalStart: number;
	internalEnd: number;
	externalStart: number;
	externalEnd: number;
	protocol: string;
	host: string;
}

export class PortMap {
	private ports: PortRange;

	private constructor(portStrOrObj: string | PortRange) {
		if (typeof portStrOrObj === 'string') {
			this.parsePortString(portStrOrObj);
		} else {
			this.ports = portStrOrObj;
		}
	}

	public toDockerOpts(): DockerPortOptions {
		const internalRange = this.generatePortRange(
			this.ports.internalStart,
			this.ports.internalEnd,
		);
		const externalRange = this.generatePortRange(
			this.ports.externalStart,
			this.ports.externalEnd,
		);

		const exposedPorts: { [key: string]: EmptyObject } = {};
		const portBindings: PortBindings = {};

		_.zipWith(internalRange, externalRange, (internal, external) => {
			exposedPorts[`${internal}/${this.ports.protocol}`] = {};

			portBindings[`${internal}/${this.ports.protocol}`] = [
				{ HostIp: this.ports.host, HostPort: external.toString() },
			];
		});

		return {
			exposedPorts,
			portBindings,
		};
	}

	/**
	 * fromDockerOpts
	 *
	 * We need to be able to compare target and running containers, but
	 * running containers store their ports in a separate format (see the
	 * output of toDockerOpts).
	 *
	 * This function takes the output of toDockerOpts (or more accurately,
	 * the output of the docker daemon when probed about a given container)
	 * and produces a list of PortMap objects, which can then be compared.
	 *
	 */
	public static fromDockerOpts(portBindings: PortBindings): PortMap[] {
		// Create a list of portBindings, rather than the map (which we can't
		// order)
		const portMaps = _.flatMap(portBindings, (hostObj, internalStr) => {
			const match = internalStr.match(DOCKER_OPTS_PORTS_REGEX);
			if (match == null) {
				throw new Error(`Could not parse docker port output: ${internalStr}`);
			}
			const internal = parseInt(match[1], 10);
			const proto = match[2] || 'tcp';

			return _.map(hostObj, ({ HostIp, HostPort }) => {
				const external = parseInt(HostPort, 10);
				const host = HostIp;
				return new PortMap({
					internalStart: internal,
					internalEnd: internal,
					externalStart: external,
					externalEnd: external,
					protocol: proto,
					host,
				});
			});
		});

		return PortMap.normalisePortMaps(portMaps);
	}

	public static normalisePortMaps(portMaps: PortMap[]): PortMap[] {
		// Fold any ranges into each other if possible
		return _(portMaps)
			.sortBy((p) => p.ports.protocol)
			.sortBy((p) => p.ports.host)
			.sortBy((p) => p.ports.internalStart)
			.reduce((res: PortMap[], p: PortMap) => {
				const last = _.last(res);

				if (
					last != null &&
					last.ports.internalEnd + 1 === p.ports.internalStart &&
					last.ports.externalEnd + 1 === p.ports.externalStart &&
					last.ports.protocol === p.ports.protocol &&
					last.ports.host === p.ports.host
				) {
					last.ports.internalEnd += 1;
					last.ports.externalEnd += 1;
				} else {
					res.push(p);
				}
				return res;
			}, []);
	}

	public static fromComposePorts(ports: string[]): PortMap[] {
		return PortMap.normalisePortMaps(ports.map((p) => new PortMap(p)));
	}

	private parsePortString(portStr: string): void {
		const match = portStr.match(PORTS_REGEX);
		if (match == null) {
			throw new InvalidPortDefinition(
				`Could not parse port definition: ${portStr}`,
			);
		}

		// Ignore the first parameter (the complete match) and separate the matched
		// values into constants and things that can change.
		const host = match[1] || '';
		const internal = match[4];
		const protocol = match[6] || 'tcp';
		let external = match[2];
		let externalEnd = match[3];
		let internalEnd = match[5];

		external ??= internal;
		internalEnd ??= internal;

		if (externalEnd == null) {
			if (internal === internalEnd) {
				// This is a special case to handle a:b
				externalEnd = external;
			} else {
				// and this handles a-b
				externalEnd = internalEnd;
			}
		}

		this.ports = {
			internalStart: parseInt(internal, 10),
			internalEnd: parseInt(internalEnd, 10),
			externalStart: parseInt(external, 10),
			externalEnd: parseInt(externalEnd, 10),
			host,
			protocol,
		};

		// Ensure we have the same range
		if (
			this.ports.internalEnd - this.ports.internalStart !==
			this.ports.externalEnd - this.ports.externalStart
		) {
			throw new InvalidPortDefinition(
				`Range for internal and external ports does not match: ${portStr}`,
			);
		}
	}

	private generatePortRange(start: number, end: number): number[] {
		if (start > end) {
			throw new Error(
				'Incorrect port range! The end port cannot be larger than the start port!',
			);
		}

		return _.range(start, end + 1);
	}
}
