process.env.DOCKER_HOST = 'unix:///your/dockerode/mocks/are/not/working';

import * as dockerode from 'dockerode';

const overrides: Dictionary<(...args: any[]) => Resolvable<any>> = {};
for (const fn of Object.getOwnPropertyNames(dockerode.prototype)) {
	if (fn !== 'constructor' && typeof (dockerode.prototype as any)[fn] === 'function') {
		console.log(`Hooking into ${fn}...`);
		const originalFn = (dockerode.prototype as any)[fn];
		(dockerode.prototype as any)[fn] = async function(...args: any[]) {
			console.log(`Calling ${fn}...`);
			if (overrides[fn] != null) {
				return overrides[fn](args);
			}
			/* Return promise */
			return Promise.resolve({});
		};
	}
}

const isIterable = (obj: any) => {
	// checks for null and undefined
	if (obj == null) {
	  return false;
	}
	return typeof obj[Symbol.iterator] === 'function';
}

export function registerOverride<T extends keyof dockerode, uA extends Parameters<dockerode[T]>, uR extends ReturnType<dockerode[T]>>(name: T, fn: (...args: uA) => uR) {
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
