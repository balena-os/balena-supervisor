import Bluebird from 'bluebird';
import once = require('lodash/once');
import requestLib from 'request';
import resumableRequestLib from 'resumable-request';
import * as config from '../config';

import supervisorVersion = require('./supervisor-version');

export { requestLib };

// With these settings, the device must be unable to receive a single byte
// from the network for a continuous period of 34.5 minutes before we give up.
// (reqTimeout + retryInterval) * retryCount / 1000ms / 60sec ~> minutes
const DEFAULT_REQUEST_TIMEOUT = 59000; // ms
const DEFAULT_REQUEST_RETRY_INTERVAL = 10000; // ms
const DEFAULT_REQUEST_RETRY_COUNT = 30;

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
	await config.initialized();
	// Generate the user agents with out versions
	const { osVersion, osVariant } = await config.getMany([
		'osVersion',
		'osVariant',
	]);
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

	const { got } = await import('got');

	const resumableOpts = {
		timeout: DEFAULT_REQUEST_TIMEOUT,
		maxRetries: DEFAULT_REQUEST_RETRY_COUNT,
		retryInterval: DEFAULT_REQUEST_RETRY_INTERVAL,
	};

	const requestHandle = requestLib.defaults(requestOpts);

	// @ts-expect-error promisifyAll is a bit wonky
	const request = Bluebird.promisifyAll(requestHandle, {
		multiArgs: true,
	}) as PromisifiedRequest;
	const resumable = resumableRequestLib.defaults(resumableOpts);

	return {
		got: got.extend({
			responseType: 'json',
			decompress: true,
			timeout: {
				// TODO: We use the same default timeout for all of these in order to have a timeout generally
				// but it would probably make sense to tune them individually
				lookup: DEFAULT_REQUEST_TIMEOUT,
				connect: DEFAULT_REQUEST_TIMEOUT,
				secureConnect: DEFAULT_REQUEST_TIMEOUT,
				socket: DEFAULT_REQUEST_TIMEOUT,
				send: DEFAULT_REQUEST_TIMEOUT,
				response: DEFAULT_REQUEST_TIMEOUT,
			},
			headers: {
				'User-Agent': userAgent,
			},
		}),
		requestOpts,
		request,
		resumable,
	};
});

export const getRequestInstance = once(async () => {
	return (await getRequestInstances()).request;
});

export const getGotInstance = once(async () => {
	return (await getRequestInstances()).got;
});

export const getRequestOptions = once(async () => {
	return (await getRequestInstances()).requestOpts;
});

export const getResumableRequest = once(async () => {
	return (await getRequestInstances()).resumable;
});
