import * as morgan from 'morgan';
import * as _ from 'lodash';

import * as apiKeys from './api-keys';
import * as config from '../config';
import log from '../lib/supervisor-console';
import { UpdatesLockedError } from '../lib/errors';

import type { Request, Response, NextFunction } from 'express';
import type { AuthorizedRequestHandler } from './types';

/**
 * Request logger
 */
export const apiLogger = morgan(
	(tokens, req, res) =>
		[
			tokens.method(req, res),
			req.path,
			tokens.status(req, res),
			'-',
			tokens['response-time'](req, res),
			'ms',
		].join(' '),
	{
		stream: { write: (d) => log.api(d.toString().trimRight()) },
	},
);

/**
 * API key validation & auth
 *
 * This middleware will extract an API key used to make a call, and then expand it out to provide
 * access to the scopes it has. The `req` will be updated to include this `auth` data.
 *
 * E.g. `req.auth.scopes: []`
 */
function getApiKeyFromRequest(req: Request): string | undefined {
	// Check query for key
	if (req.query.apikey) {
		// Handle non-string? req.query.apikey's type can be `string | QueryString.ParsedQs | string[] | QueryString.ParsedQs[]`
		return req.query.apikey as string;
	}

	// Get Authorization header to search for key
	const authHeader = req.get('Authorization');

	// Check header for key
	if (!authHeader) {
		return undefined;
	}

	// Check authHeader with various schemes
	const match = authHeader.match(/^(?:ApiKey|Bearer) (\w+)$/i);

	// Return key from match or undefined
	return match?.[1];
}

export const auth: AuthorizedRequestHandler = async (req, res, next) => {
	// grab the API key used for the request
	const apiKey = getApiKeyFromRequest(req) ?? '';

	// store the key in the request, and an empty scopes array to populate after resolving the key scopes
	req.auth = {
		apiKey,
		scopes: [],
		isScoped: (resources) => apiKeys.isScoped(resources, req.auth.scopes),
	};

	try {
		const conf = await config.getMany(['localMode', 'unmanaged']);

		// we only need to check the API key if managed and not in local mode
		const needsAuth = !conf.unmanaged && !conf.localMode;

		// no need to authenticate, shortcut
		if (!needsAuth) {
			// Allow requests that do not need auth to be scoped for all applications
			req.auth.isScoped = () => true;
			return next();
		}

		// if we have a key, find the scopes and add them to the request
		if (apiKey && apiKey !== '') {
			await apiKeys.initialized;
			const scopes = await apiKeys.getScopesForKey(apiKey);

			if (scopes != null) {
				// keep the scopes for later incase they're desired
				req.auth.scopes.push(...scopes);
				return next();
			}
		}

		// we do not have a valid key...
		return res.sendStatus(401);
	} catch (err) {
		console.error(err);
		res.status(503).send(`Unexpected error: ${err}`);
	}
};

/**
 * Error handling
 */
const messageFromError = (err?: Error | string | null): string => {
	let message = 'Unknown error';
	if (err != null) {
		if (_.isError(err) && err.message != null) {
			message = err.message;
		} else {
			message = err as string;
		}
	}
	return message;
};

export const errorHandler = (
	err: Error,
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	if (res.headersSent) {
		// Error happens while we are writing the response - default handler closes the connection.
		next(err);
		return;
	}

	// Return 423 Locked when locks as set
	const code = err instanceof UpdatesLockedError ? 423 : 503;
	if (code !== 423) {
		log.error(`Error on ${req.method} ${req.path}: `, err);
	}

	res.status(code).send({
		status: 'failed',
		message: messageFromError(err),
	});
};
