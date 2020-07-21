process.env.DOCKER_HOST = 'unix:///your/dockerode/mocks/are/not/working';

import * as dockerode from 'dockerode';

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
