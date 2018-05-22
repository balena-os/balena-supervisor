import * as _ from 'lodash';
import TypedError = require('typed-error');

// Adapted from https://github.com/docker/docker-py/blob/master/docker/utils/ports.py#L3
const PORTS_REGEX =
	/^(?:(?:([a-fA-F\d.:]+):)?([\d]*)(?:-([\d]+))?:)?([\d]+)(?:-([\d]+))?(?:\/(udp|tcp))?$/;

// A regex to extract the protocol and internal port of the incoming Docker options
const DOCKER_OPTS_PORTS_REGEX =  /(\d+)(?:\/?([a-z]+))?/i;

export class InvalidPortDefinition extends TypedError { }

export interface PortBindings {
	[key: string]: Array<{ HostIp: string, HostPort: string }>;
}

export interface DockerPortOptions {
	exposedPorts: Map<string, {}>;
	portBindings: PortBindings;
}

interface PortRange {
	internalStart: number;
	internalEnd: number;
	externalStart: number;
	externalEnd: number;
	protocol: string;
	host: string;
}

export class PortMap {

	private internalStart: number;
	private internalEnd: number;
	private externalStart: number;
	private externalEnd: number;
	private protocol: string;
	private host: string;

	public constructor(portStrOrObj: string | PortRange) {
		if (_.isString(portStrOrObj)) {
			this.parsePortString(portStrOrObj);
		} else {
			this.internalStart = portStrOrObj.internalStart;
			this.internalEnd = portStrOrObj.internalEnd;
			this.externalStart = portStrOrObj.externalStart;
			this.externalEnd = portStrOrObj.externalEnd;
			this.protocol = portStrOrObj.protocol;
			this.host = portStrOrObj.host;
		}
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
	public static fromDockerOpts(
		portBindings: PortBindings,
	): PortMap[] {

		// Create a list of portBindings, rather than the map (which we can't
		// order)
		const portMaps = _.map(portBindings, (hostObj, internalStr) => {

			const match = internalStr.match(DOCKER_OPTS_PORTS_REGEX);
			if (match == null) {
				throw new Error(`Could not parse docker port output: ${internalStr}`);
			}
			const internal = parseInt(match[1], 10);
			const external = parseInt(hostObj[0].HostPort, 10);

			const host = hostObj[0].HostIp;
			const proto = match[2] || 'tcp';

			return new PortMap({
				internalStart: internal,
				internalEnd: internal,
				externalStart: external,
				externalEnd: external,
				protocol: proto,
				host,
			});
		});

		return PortMap.normalisePortMaps(portMaps);
	}

	public static normalisePortMaps(portMaps: PortMap[]): PortMap[] {
		// Fold any ranges into each other if possible
		return _(portMaps)
			.sortBy((p) => p.protocol)
			.sortBy((p) => p.host)
			.sortBy((p) => p.internalStart)
			.reduce((res: PortMap[], p: PortMap) => {
				const last = _.last(res);
				if (last == null) {
					res.push(p);
				} else {
					if (last.internalEnd + 1 === p.internalStart &&
						last.externalEnd + 1 === p.externalStart &&
						last.protocol === p.protocol &&
						last.host === p.host
					) {
						last.internalEnd += 1;
						last.externalEnd += 1;
					} else {
						res.push(p);
					}
				}
				return res;
			}, []);
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
