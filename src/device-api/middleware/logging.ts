import morgan from 'morgan';
import type { Request } from 'express';

import log from '../../lib/supervisor-console';

export const logging = morgan(
	(tokens, req: Request, res) =>
		[
			tokens.method(req, res),
			req.path,
			tokens.status(req, res),
			'-',
			tokens['response-time'](req, res),
			'ms',
		].join(' '),
	{
		stream: {
			write: (d) => {
				log.api(d.toString().trimEnd());
			},
		},
	},
);
