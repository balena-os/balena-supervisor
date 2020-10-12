import { expect } from 'chai';
import * as sysInfo from '../src/lib/system-info';

import { SinonStub, stub } from 'sinon';
import * as systeminformation from 'systeminformation';

function toMb(bytes: number) {
	return Math.floor(bytes / 1024 / 1024);
}

function toBytes(kb: number) {
	return kb * 1024;
}

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

	describe('Memory information', function () {
		it('should return the correct value for memory usage', async () => {
			const [total, free, cached, buffers] = [
				763472,
				143896,
				368360,
				16724,
			].map(toBytes);

			// Stub the output of the systeminformation module
			stub(systeminformation, 'mem').resolves({
				total,
				free,
				used: total - free,
				cached,
				buffers,
				slab: 0,
				buffcache: 0,
				available: 0,
				active: 0,
				swaptotal: 0,
				swapfree: 0,
				swapused: 0,
			});

			const meminfo = await sysInfo.getMemoryInformation();
			expect(meminfo.total).to.be.equal(toMb(total));

			// used memory = total - free - (cached + buffers)
			// this is how `htop` and `free` calculate it
			expect(meminfo.used).to.be.equal(toMb(total - free - (cached + buffers)));

			(systeminformation.mem as SinonStub).restore();
		});
	});
});
