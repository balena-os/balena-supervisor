import { expect } from 'chai';
import * as sysInfo from '../src/lib/system-info';

describe('System information', () => {
	describe('Delta-based filtering', () => {
		it('should correctly filter cpu usage', () => {
			expect(
				sysInfo.filterNonSignificantChanges({ cpu_usage: 21 }, {
					cpu_usage: 20,
				} as sysInfo.SystemInfo),
			).to.deep.equal(['cpu_usage']);

			expect(
				sysInfo.filterNonSignificantChanges({ cpu_usage: 10 }, {
					cpu_usage: 20,
				} as sysInfo.SystemInfo),
			).to.deep.equal([]);
		});

		it('should correctly filter cpu temperature', () => {
			expect(
				sysInfo.filterNonSignificantChanges({ cpu_temp: 21 }, {
					cpu_temp: 22,
				} as sysInfo.SystemInfo),
			).to.deep.equal(['cpu_temp']);

			expect(
				sysInfo.filterNonSignificantChanges({ cpu_temp: 10 }, {
					cpu_temp: 20,
				} as sysInfo.SystemInfo),
			).to.deep.equal([]);
		});

		it('should correctly filter memory usage', () => {
			expect(
				sysInfo.filterNonSignificantChanges({ memory_usage: 21 }, {
					memory_usage: 22,
				} as sysInfo.SystemInfo),
			).to.deep.equal(['memory_usage']);

			expect(
				sysInfo.filterNonSignificantChanges({ memory_usage: 10 }, {
					memory_usage: 20,
				} as sysInfo.SystemInfo),
			).to.deep.equal([]);
		});

		it('should not filter if we didnt have a past value', () => {
			expect(
				sysInfo.filterNonSignificantChanges({}, {
					memory_usage: 22,
					cpu_usage: 10,
					cpu_temp: 5,
				} as sysInfo.SystemInfo),
			).to.deep.equal([]);
		});
	});
});
