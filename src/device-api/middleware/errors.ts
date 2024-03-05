import _ from 'lodash';

import { UpdatesLockedError } from '../../lib/errors';
import log from '../../lib/supervisor-console';

import type { Request, Response, NextFunction } from 'express';

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

export const errors = (
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
