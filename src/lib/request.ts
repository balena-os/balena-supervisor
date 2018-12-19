import * as Bluebird from 'bluebird';
import * as requestLib from 'request';
import * as resumableRequestLib from 'resumable-request';

import * as constants from './constants';
import * as osRelease from './os-release';

import supervisorVersion = require('./supervisor-version');

const osVersion = osRelease.getOSVersionSync(constants.hostOSVersionPath);
const osVariant = osRelease.getOSVariantSync(constants.hostOSVersionPath);

let userAgent = `Supervisor/${supervisorVersion}`;
if (osVersion != null) {
	if (osVariant != null) {
		userAgent += ` (Linux; ${osVersion}; ${osVariant})`;
	} else {
		userAgent += ` (Linux; ${osVersion})`;
	}
}

// With these settings, the device must be unable to receive a single byte
// from the network for a continuous period of 20 minutes before we give up.
// (reqTimeout + retryInterval) * retryCount / 1000ms / 60sec ~> minutes
const DEFAULT_REQUEST_TIMEOUT = 30000; // ms
const DEFAULT_REQUEST_RETRY_INTERVAL = 10000; // ms
const DEFAULT_REQUEST_RETRY_COUNT = 30;

export const requestOpts = {
	gzip: true,
	timeout: DEFAULT_REQUEST_TIMEOUT,
	headers: {
		'User-Agent': userAgent,
	},
};

const resumableOpts = {
	timeout: DEFAULT_REQUEST_TIMEOUT,
	maxRetries: DEFAULT_REQUEST_RETRY_COUNT,
	retryInterval: DEFAULT_REQUEST_RETRY_INTERVAL,
};

const requestHandle = requestLib.defaults(exports.requestOpts);

export const request = Bluebird.promisifyAll(requestHandle, {
	multiArgs: true,
});
export const resumable = resumableRequestLib.defaults(resumableOpts);
