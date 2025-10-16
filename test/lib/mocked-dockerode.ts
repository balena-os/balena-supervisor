/* eslint @typescript-eslint/require-await: 0 */

process.env.DOCKER_HOST = 'unix:///your/dockerode/mocks/are/not/working';

import Dockerode from 'dockerode';
import { Stream } from 'stream';
import _ from 'lodash';
import { NotFoundError } from '~/lib/errors';

const overrides: Dictionary<(...args: any[]) => Resolvable<any>> = {};

interface Action {
	name: string;
	parameters: Dictionary<any>;
}

export let actions: Action[] = [];

export function resetHistory() {
	actions = [];
}

/**
 * Tracks actions performed on a mocked dockerode instance
 * @param name action called
 * @param parameters data passed
 */
function addAction(name: string, parameters: Dictionary<any> = {}) {
	actions.push({
		name,
		parameters,
	});
}

type DockerodeFunction = keyof Omit<Dockerode, 'modem'>;
for (const fn of Object.getOwnPropertyNames(Dockerode.prototype)) {
	if (
		fn !== 'constructor' &&
		typeof (Dockerode.prototype as any)[fn] === 'function'
	) {
		(Dockerode.prototype as any)[fn] = async function (...args: any[]) {
			console.log(`🐳  Calling ${fn}...`);
			if (overrides[fn] != null) {
				return overrides[fn](args);
			}

			/* Return promise */
			return Promise.resolve([]);
		};
	}
}

// default overrides needed to startup...
registerOverride(
	'getEvents',
	async () =>
		new Stream.Readable({
			read: () => {
				_.noop();
			},
		}),
);

/**
 * Used to add or modifying functions on the mocked dockerode
 * @param name function name to override
 * @param fn function to execute
 */
export function registerOverride<
	T extends DockerodeFunction,
	P extends Parameters<Dockerode[T]>,
	R extends ReturnType<Dockerode[T]>,
>(name: T, fn: (...args: P) => R) {
	console.log(`Overriding ${name}...`);
	overrides[name] = fn;
}

export function restoreOverride<T extends DockerodeFunction>(name: T) {
	if (Object.hasOwn(overrides, name)) {
		delete overrides[name];
	}
}

export interface TestData {
	networks: Dictionary<any>;
	images: Dictionary<any>;
	containers: Dictionary<any>;
	volumes: Dictionary<any>;
}

function createMockedDockerode(data: TestData) {
	const mockedDockerode = Dockerode.prototype;

	mockedDockerode.listImages = async () => [];

	mockedDockerode.listVolumes = async () => {
		addAction('listVolumes');
		return {
			Volumes: data.volumes as Dockerode.VolumeInspectInfo[],
			Warnings: [],
		};
	};

	mockedDockerode.getVolume = (name: string) => {
		addAction('getVolume');
		const picked = data.volumes.filter((v: Dictionary<any>) => v.Name === name);
		if (picked.length !== 1) {
			throw new NotFoundError();
		}
		const volume = picked[0];
		return {
			...volume,
			inspect: async () => {
				addAction('inspect');
				// TODO fully implement volume inspect.
				// This should return VolumeInspectInfo not Volume
				return volume;
			},
			remove: async (options?: any) => {
				addAction('remove', options);
				data.volumes = _.reject(data.volumes, { name: volume.name });
			},
			name: volume.name,
			modem: {},
		} as Dockerode.Volume;
	};

	mockedDockerode.createContainer = async (
		options: Dockerode.ContainerCreateOptions,
	) => {
		addAction('createContainer', { options });
		return {
			start: async () => {
				addAction('start');
			},
		} as Dockerode.Container;
	};

	mockedDockerode.getContainer = (id: string) => {
		addAction('getContainer', { id });
		return {
			inspect: async () => {
				return data.containers.filter((c: Dictionary<any>) => c.id === id);
			},
			start: async () => {
				addAction('start');
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'Installing';
					}
					return c;
				});
			},
			stop: async () => {
				addAction('stop');
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'Stopping';
					}
					return c;
				});
			},
			remove: async () => {
				addAction('remove');
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'removing';
					}
					return c;
				});
			},
		} as Dockerode.Container;
	};

	mockedDockerode.getNetwork = (id: string) => {
		addAction('getNetwork', { id });
		return {
			inspect: async () => {
				addAction('inspect');
				return data.networks[id];
			},
		} as Dockerode.Network;
	};

	mockedDockerode.getImage = (name: string) => {
		addAction('getImage', { name });
		return {
			inspect: async () => {
				addAction('inspect');
				return data.images[name];
			},
			remove: async () => {
				addAction('remove');
				data.images = _.reject(data.images, {
					name,
				});
			},
		} as Dockerode.Image;
	};

	return mockedDockerode;
}

type Prototype = { [key: string]: any };
function clonePrototype(prototype: Prototype): Prototype {
	const clone: Prototype = {};
	Object.getOwnPropertyNames(prototype).forEach((fn) => {
		if (fn !== 'constructor' && typeof prototype[fn] === 'function') {
			clone[fn] = prototype[fn];
		}
	});

	return clone;
}

function assignPrototype(target: Prototype, source: Prototype) {
	Object.keys(source).forEach((fn) => {
		target[fn] = source[fn];
	});
}

export async function testWithData(
	data: Partial<TestData>,
	test: () => Promise<any>,
) {
	const mockedData: TestData = {
		...{
			networks: [],
			images: [],
			containers: [],
			volumes: [],
		},
		...data,
	};

	// grab the original prototype...
	const basePrototype = clonePrototype(Dockerode.prototype);
	Dockerode.prototype = createMockedDockerode(mockedData);

	try {
		// run the test...
		await test();
	} finally {
		// reset the original prototype...
		assignPrototype(Dockerode.prototype, basePrototype);
	}
}
