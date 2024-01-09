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

	describe('LocksTakenMap', () => {
		it('should be an instance of Map<number, Set<string>>', () => {
			const map = new updateLock.LocksTakenMap();
			expect(map).to.be.an.instanceof(Map);
		});

		it('should add services while ignoring duplicates', () => {
			const map = new updateLock.LocksTakenMap();
			map.add(123, 'main');
			expect(map.getServices(123)).to.deep.include.members(['main']);

			map.add(123, 'main');
			expect(map.getServices(123)).to.deep.include.members(['main']);

			map.add(123, ['main', 'aux']);
			expect(map.getServices(123)).to.deep.include.members(['main', 'aux']);
		});

		it('should track any number of appIds', () => {
			const map = new updateLock.LocksTakenMap();
			map.add(123, 'main');
			map.add(456, ['aux', 'dep']);
			expect(map.getServices(123)).to.deep.include.members(['main']);
			expect(map.getServices(456)).to.deep.include.members(['aux', 'dep']);
			expect(map.size).to.equal(2);
		});

		it('should return empty array for non-existent appIds', () => {
			const map = new updateLock.LocksTakenMap();
			expect(map.getServices(123)).to.deep.equal([]);
		});

		it('should return whether a service is locked under an appId', () => {
			const map = new updateLock.LocksTakenMap();
			map.add(123, 'main');
			expect(map.isLocked(123, 'main')).to.be.true;
			expect(map.isLocked(123, 'aux')).to.be.false;
			expect(map.isLocked(456, 'main')).to.be.false;
		});
	});
});
