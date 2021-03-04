import * as Bluebird from 'bluebird';
import once = require('lodash/once');
import * as requestLib from 'request';

import * as constants from './constants';
import * as osRelease from './os-release';

import supervisorVersion = require('./supervisor-version');

export { requestLib };

const DEFAULT_REQUEST_TIMEOUT = 30000; // ms

type PromisifiedRequest = typeof requestLib & {
	delAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	putAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	postAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	patchAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	getAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
};

const getRequestInstances = once(async () => {
	// Generate the user agents with out versions
	const osVersion = await osRelease.getOSVersion(constants.hostOSVersionPath);
	const osVariant = await osRelease.getOSVariant(constants.hostOSVersionPath);
	let userAgent = `Supervisor/${supervisorVersion}`;
	if (osVersion != null) {
		if (osVariant != null) {
			userAgent += ` (Linux; ${osVersion}; ${osVariant})`;
		} else {
			userAgent += ` (Linux; ${osVersion})`;
		}
	}

	const requestOpts: requestLib.CoreOptions = {
		gzip: true,
		timeout: DEFAULT_REQUEST_TIMEOUT,
		headers: {
			'User-Agent': userAgent,
		},
	};

	const requestHandle = requestLib.defaults(requestOpts);

	const request = Bluebird.promisifyAll(requestHandle, {
		multiArgs: true,
	}) as PromisifiedRequest;

	return {
		requestOpts,
		request,
	};
});

export const getRequestInstance = once(async () => {
	return (await getRequestInstances()).request;
});

export const getRequestOptions = once(async () => {
	return (await getRequestInstances()).requestOpts;
});
