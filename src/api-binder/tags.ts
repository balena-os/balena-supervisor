import * as db from '../db';
import * as config from '../config';
import { log } from '../lib/supervisor-console';
import { createHandleRetry, withBackoff } from '../lib/backoff';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getDefaultHeaders } from '../lib/request';
import { setTimeout } from 'timers/promises';
import { once } from 'lodash';
import type { SchemaReturn } from '../config/schema-type';

type TagsPatchV3Body = {
	[uuid: string]: {
		[tagKey: string]: string;
	};
};
type TagsPatchRecord = TagsPatchV3Body[string];

const reportedTags: TagsPatchRecord = {};
const targetTags: TagsPatchRecord = {};

let reportConfigs:
	| Awaited<
			ReturnType<
				typeof config.getMany<
					| 'apiEndpoint'
					| 'apiRequestTimeout'
					| 'deviceApiKey'
					| 'appUpdatePollInterval'
					| 'uuid'
				>
			>
	  >
	| undefined;

export const initialized = once(async () => {
	await db.initialized();
	await config.initialized();

	let reported: SchemaReturn<'reportedTags'>;
	let target: SchemaReturn<'targetTags'>;

	({
		reportedTags: reported,
		targetTags: target,
		...reportConfigs
	} = await config.getMany([
		'apiEndpoint',
		'apiRequestTimeout',
		'deviceApiKey',
		'appUpdatePollInterval',
		'uuid',
		'reportedTags',
		'targetTags',
	]));

	if (reported != null) {
		for (const key of Object.keys(reported)) {
			reportedTags[key] = reported[key];
		}
	}
	if (target != null) {
		let isDifferent = false;
		for (const key of Object.keys(target)) {
			targetTags[key] = target[key];
			if (reportedTags[key] !== targetTags[key]) {
				isDifferent = true;
			}
		}
		if (isDifferent) {
			triggerReport();
		}
	}
});

export const setTags = async (tags: TagsPatchRecord) => {
	let hasChanged = false;
	for (const [key, value] of Object.entries(tags)) {
		if (targetTags[key] !== value) {
			if (targetTags[key] == null && reportedTags[key] === value) {
				// If the tag isn't already queued for update and we're setting to the currently reported value the we can just skip over the update
				continue;
			}
			targetTags[key] = value;
			hasChanged = true;
		}
	}
	if (hasChanged) {
		triggerReport();
		await config.set({ targetTags });
	}
};

async function report(tagsDiff: TagsPatchRecord) {
	const { apiEndpoint, apiRequestTimeout, deviceApiKey } = reportConfigs!;

	if (!apiEndpoint) {
		throw new InternalInconsistencyError(
			'No apiEndpoint available for patching device tags',
		);
	}

	const endpoint = new URL('/device/v3/tags', apiEndpoint);
	const defaultHeaders = await getDefaultHeaders();

	const res = await fetch(endpoint, {
		method: 'PATCH',
		headers: {
			...defaultHeaders,
			Authorization: `Bearer ${deviceApiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			[reportConfigs!.uuid!]: tagsDiff,
		} satisfies TagsPatchV3Body),
		signal: AbortSignal.timeout(apiRequestTimeout),
	});

	if (res.status < 200 || res.status >= 300) {
		const retryAfter = res.headers.get('retry-after');
		let jsonBody;
		try {
			jsonBody = await res.json();
		} catch {
			// ignore
		}
		throw new StatusError(
			res.status,
			jsonBody != null ? JSON.stringify(jsonBody, null, 2) : undefined,
			retryAfter ? parseInt(retryAfter, 10) : undefined,
		);
	}
}

/**
 * Collects current state and reports. Diffs report content with
 * previous report and does not send an empty report.
 * Should only be called by `reportCurrentStateWithBackoff` which wraps with backoff
 */
const reportCurrentState = async () => {
	const tagsDiff: TagsPatchRecord = {};
	for (const key of Object.keys(targetTags)) {
		if (reportedTags[key] !== targetTags[key]) {
			tagsDiff[key] = targetTags[key];
		} else {
			// If the values match then remove it, saving memory and ensuring the `Object.keys(targetTags).length` checks work as expected.
			// Ideally we shouldn't hit/need this case but it's a final safeguard against potential unexpected behavior.
			delete targetTags[key];
		}
	}

	if (Object.keys(tagsDiff).length === 0) {
		return;
	}

	await report(tagsDiff);
	lastReportTime = performance.now();
	for (const key of Object.keys(tagsDiff)) {
		reportedTags[key] = targetTags[key];
		if (targetTags[key] === tagsDiff[key]) {
			delete targetTags[key];
		}
	}
	await config.set({ reportedTags, targetTags });

	log.info('Reported device tags to the cloud');
};
/**
 * Reports current state with backoff for failures.
 *
 * Does *not* validate time elapsed since last report.
 */
async function reportCurrentStateWithBackoff() {
	// Create a report that will backoff on errors
	const reportWithBackoff = withBackoff(reportCurrentState, {
		maxDelay: reportConfigs!.appUpdatePollInterval,
		minDelay: 15000,
		onFailure: createHandleRetry('Device tags'),
	});

	// Run in try block to avoid throwing any exceptions
	try {
		await reportWithBackoff();
	} catch (e) {
		log.error(e);
	}
}

// How often can we report our state to the server in ms
const maxReportFrequency = 10 * 1000;
let lastReportTime = -Infinity;
let reportLoopInProgress = false;
const triggerReport = () => {
	if (reportLoopInProgress) {
		return;
	}
	reportLoopInProgress = true;
	void (async () => {
		try {
			while (true) {
				try {
					if (performance.now() - lastReportTime > maxReportFrequency) {
						await reportCurrentStateWithBackoff();
					}
				} finally {
					const delay =
						maxReportFrequency - (performance.now() - lastReportTime);
					// Wait until we want to report again
					await setTimeout(delay);

					// If there's no updated target tags then we can stop the loop until a change comes in.
					if (Object.keys(targetTags).length === 0) {
						// eslint-disable-next-line no-unsafe-finally -- We very intentionally want to end the loop here.
						return;
					}
				}
			}
		} finally {
			reportLoopInProgress = false;
		}
	})();
};
