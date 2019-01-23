import * as Bluebird from 'bluebird';
import DockerToolbelt = require('docker-toolbelt');
import { SchemaReturn } from '../config/schema-type';

// This is the EnvVarObject from src/lib/types, but it seems we cannot
// reference it relatively. Just redefine it as it's simple and won't change
// often

interface EnvVarObject {
	[name: string]: string;
}

interface TaggedRepoImage {
	repo: string;
	tag: string;
}

type FetchOptions = SchemaReturn<'fetchOptions'>;

declare class DockerUtils extends DockerToolbelt {
	constructor(opts: any);

	getRepoAndTag(image: string): Bluebird<TaggedRepoImage>;

	fetchDeltaWithProgress(
		imgDest: string,
		fullDeltaOpts: any,
		onProgress: (args: any) => void,
	): Bluebird<string>;

	fetchImageWithProgress(
		image: string,
		config: FetchOptions,
		onProgress: (args: any) => void,
	): Bluebird<string>;

	getImageEnv(id: string): Bluebird<EnvVarObject>;
	getNetworkGateway(netName: string): Bluebird<string>;
}

export = DockerUtils;
