process.env.DOCKER_HOST = 'unix:///your/dockerode/mocks/are/not/working';

import * as dockerode from 'dockerode';
import { Stream } from 'stream';
import _ = require('lodash');

const overrides: Dictionary<(...args: any[]) => Resolvable<any>> = {};

type DockerodeFunction = keyof dockerode;
for (const fn of Object.getOwnPropertyNames(dockerode.prototype)) {
	if (
		fn !== 'constructor' &&
		typeof (dockerode.prototype as any)[fn] === 'function'
	) {
		(dockerode.prototype as any)[fn] = async function (...args: any[]) {
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
registerOverride('listImages', async () => []);
registerOverride(
	'getEvents',
	async () =>
		new Stream.Readable({
			read: () => {
				return _.noop() as any;
			},
		}),
);

export function registerOverride<
	T extends DockerodeFunction,
	P extends Parameters<dockerode[T]>,
	R extends ReturnType<dockerode[T]>
>(name: T, fn: (...args: P) => R) {
	console.log(`Overriding ${name}...`);
	overrides[name] = fn;
}

export interface TestData {
	networks: Dictionary<any>;
	images: Dictionary<any>;
}

function createMockedDockerode(data: TestData) {
	const mockedDockerode = dockerode.prototype;
	mockedDockerode.getNetwork = (id: string) => {
		return {
			inspect: async () => {
				return data.networks[id];
			},
		} as dockerode.Network;
	};

	mockedDockerode.getImage = (name: string) => {
		return {
			inspect: async () => {
				return data.images[name];
			},
		} as dockerode.Image;
	};

	return mockedDockerode;
}

export async function testWithData(
	data: Partial<TestData>,
	test: () => Promise<any>,
) {
	const mockedData: TestData = {
		...{
			networks: {},
			images: {},
			containers: {},
		},
		...data,
	};

	// grab the original prototype...
	const basePrototype = dockerode.prototype;

	// @ts-expect-error setting a RO property
	dockerode.prototype = createMockedDockerode(mockedData);

	try {
		// run the test...
		await test();
	} finally {
		// reset the original prototype...
		// @ts-expect-error setting a RO property
		dockerode.prototype = basePrototype;
	}
}
