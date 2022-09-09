import { expect } from 'chai';
import * as path from 'path';

import * as updateLock from '~/lib/update-lock';

describe('lib/update-lock: unit tests', () => {
	describe('lockPath', () => {
		it('should return path prefix of service lockfiles on host', () => {
			expect(updateLock.lockPath(123)).to.equal(
				path.join(updateLock.BASE_LOCK_DIR, '123'),
			);
			expect(updateLock.lockPath(123, 'main')).to.equal(
				path.join(updateLock.BASE_LOCK_DIR, '123', 'main'),
			);
		});
	});
});
