import blinking from 'blinking';
import memoizee from 'memoizee';

export type Blink = ReturnType<typeof blinking>;

import { exists } from './fs-utils';
import { ledFile } from './constants';

export const getBlink = memoizee(
	async (): Promise<Blink> => {
		if (!(await exists(ledFile))) {
			return blinking('/dev/null');
		}

		return blinking(ledFile);
	},
	{ promise: true },
);
