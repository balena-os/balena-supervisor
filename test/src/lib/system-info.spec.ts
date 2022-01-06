import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';
import { promises as fs } from 'fs';
import * as systeminformation from 'systeminformation';

import * as fsUtils from '../../../src/lib/fs-utils';
import * as sysInfo from '../../../src/lib/system-info';

describe('System information', () => {
	before(() => {
		stub(systeminformation, 'fsSize');
		stub(systeminformation, 'mem').resolves(mockMemory);
		stub(systeminformation, 'currentLoad').resolves(mockCPU.load);
		stub(systeminformation, 'cpuTemperature').resolves(mockCPU.temp);
		// @ts-ignore TS thinks we can't return a buffer...
		stub(fs, 'readFile').resolves(mockCPU.idBuffer);
		stub(fsUtils, 'exec');
	});

	after(() => {
		(systeminformation.fsSize as SinonStub).restore();
		(systeminformation.mem as SinonStub).restore();
		(systeminformation.currentLoad as SinonStub).restore();
		(systeminformation.cpuTemperature as SinonStub).restore();
		(fs.readFile as SinonStub).restore();
		(fsUtils.exec as SinonStub).restore();
	});

	describe('isSignificantChange', () => {
		it('should correctly filter cpu usage', () => {
			expect(sysInfo.isSignificantChange('cpu_usage', 21, 20)).to.be.false;
			expect(sysInfo.isSignificantChange('cpu_usage', 10, 20)).to.be.true;
		});

		it('should correctly filter cpu temperature', () => {
			expect(sysInfo.isSignificantChange('cpu_temp', 21, 22)).to.be.false;
			expect(sysInfo.isSignificantChange('cpu_temp', 10, 20)).to.be.true;
		});

		it('should correctly filter memory usage', () => {
			expect(sysInfo.isSignificantChange('memory_usage', 21, 22)).to.be.false;
			expect(sysInfo.isSignificantChange('memory_usage', 10, 20)).to.be.true;
		});

		it("should not filter if we didn't have a past value", () => {
			expect(sysInfo.isSignificantChange('cpu_usage', undefined, 22)).to.be
				.true;
			expect(sysInfo.isSignificantChange('cpu_temp', undefined, 10)).to.be.true;
			expect(sysInfo.isSignificantChange('memory_usage', undefined, 5)).to.be
				.true;
		});

		it('should not filter if the current value is null', () => {
			// When the current value is null, we're sending a null patch to the
			// API in response to setting DISABLE_HARDWARE_METRICS to true, so
			// we need to include null for all values. None of the individual metrics
			// in systemMetrics return null (only number/undefined), so the only
			// reason for current to be null is when a null patch is happening.
			expect(sysInfo.isSignificantChange('cpu_usage', 15, null as any)).to.be
				.true;
			expect(sysInfo.isSignificantChange('cpu_temp', 55, null as any)).to.be
				.true;
			expect(sysInfo.isSignificantChange('memory_usage', 760, null as any)).to
				.be.true;
		});

		it('should not filter if the current value is null', () => {
			// When the current value is null, we're sending a null patch to the
			// API in response to setting HARDWARE_METRICS to false, so
			// we need to include null for all values. None of the individual metrics
			// in systemMetrics return null (only number/undefined), so the only
			// reason for current to be null is when a null patch is happening.
			expect(sysInfo.isSignificantChange('cpu_usage', 15, null as any)).to.be
				.true;
			expect(sysInfo.isSignificantChange('cpu_temp', 55, null as any)).to.be
				.true;
			expect(sysInfo.isSignificantChange('memory_usage', 760, null as any)).to
				.be.true;
		});
	});

	describe('CPU information', () => {
		it('gets CPU usage', async () => {
			const cpuUsage = await sysInfo.getCpuUsage();
			// Make sure it is a whole number
			expect(cpuUsage % 1).to.equal(0);
			// Make sure it's the right number given the mocked data
			expect(cpuUsage).to.equal(1);
		});

		it('gets CPU temp', async () => {
			const tempInfo = await sysInfo.getCpuTemp();
			// Make sure it is a whole number
			expect(tempInfo % 1).to.equal(0);
			// Make sure it's the right number given the mocked data
			expect(tempInfo).to.equal(51);
		});

		it('gets CPU ID', async () => {
			const cpuId = await sysInfo.getSystemId();
			expect(cpuId).to.equal('1000000001b93f3f');
		});
	});

	describe('getMemoryInformation', async () => {
		it('should return the correct value for memory usage', async () => {
			const memoryInfo = await sysInfo.getMemoryInformation();
			expect(memoryInfo).to.deep.equal({
				total: sysInfo.bytesToMb(mockMemory.total),
				used: sysInfo.bytesToMb(
					mockMemory.total -
						mockMemory.free -
						(mockMemory.cached + mockMemory.buffers),
				),
			});
		});
	});

	describe('getStorageInfo', async () => {
		it('should return info on /data mount', async () => {
			(systeminformation.fsSize as SinonStub).resolves(mockFS);
			const storageInfo = await sysInfo.getStorageInfo();
			expect(storageInfo).to.deep.equal({
				blockDevice: '/dev/mmcblk0p6',
				storageUsed: 1118,
				storageTotal: 29023,
			});
		});

		it('should handle no /data mount', async () => {
			(systeminformation.fsSize as SinonStub).resolves([]);
			const storageInfo = await sysInfo.getStorageInfo();
			expect(storageInfo).to.deep.equal({
				blockDevice: '',
				storageUsed: undefined,
				storageTotal: undefined,
			});
		});
	});

	describe('undervoltageDetected', () => {
		it('should detect undervoltage', async () => {
			(fsUtils.exec as SinonStub).resolves({
				stdout: Buffer.from(
					'[58611.126996] Under-voltage detected! (0x00050005)',
				),
				stderr: Buffer.from(''),
			});
			expect(await sysInfo.undervoltageDetected()).to.be.true;
			(fsUtils.exec as SinonStub).resolves({
				stdout: Buffer.from('[569378.450066] eth0: renamed from veth3aa11ca'),
				stderr: Buffer.from(''),
			});
			expect(await sysInfo.undervoltageDetected()).to.be.false;
		});
	});
});

const mockCPU = {
	temp: {
		main: 50.634,
		cores: [],
		max: 50.634,
		socket: [],
	},
	load: {
		avgLoad: 0.6,
		currentLoad: 1.4602487831260142,
		currentLoadUser: 0.7301243915630071,
		currentLoadSystem: 0.7301243915630071,
		currentLoadNice: 0,
		currentLoadIdle: 98.53975121687398,
		currentLoadIrq: 0,
		rawCurrentLoad: 5400,
		rawCurrentLoadUser: 2700,
		rawCurrentLoadSystem: 2700,
		rawCurrentLoadNice: 0,
		rawCurrentLoadIdle: 364400,
		rawCurrentLoadIrq: 0,
		cpus: [
			{
				load: 1.8660812294182216,
				loadUser: 0.7683863885839737,
				loadSystem: 1.0976948408342482,
				loadNice: 0,
				loadIdle: 98.13391877058177,
				loadIrq: 0,
				rawLoad: 1700,
				rawLoadUser: 700,
				rawLoadSystem: 1000,
				rawLoadNice: 0,
				rawLoadIdle: 89400,
				rawLoadIrq: 0,
			},
			{
				load: 1.7204301075268817,
				loadUser: 0.8602150537634409,
				loadSystem: 0.8602150537634409,
				loadNice: 0,
				loadIdle: 98.27956989247312,
				loadIrq: 0,
				rawLoad: 1600,
				rawLoadUser: 800,
				rawLoadSystem: 800,
				rawLoadNice: 0,
				rawLoadIdle: 91400,
				rawLoadIrq: 0,
			},
			{
				load: 1.186623516720604,
				loadUser: 0.9708737864077669,
				loadSystem: 0.2157497303128371,
				loadNice: 0,
				loadIdle: 98.8133764832794,
				loadIrq: 0,
				rawLoad: 1100,
				rawLoadUser: 900,
				rawLoadSystem: 200,
				rawLoadNice: 0,
				rawLoadIdle: 91600,
				rawLoadIrq: 0,
			},
			{
				load: 1.0752688172043012,
				loadUser: 0.3225806451612903,
				loadSystem: 0.7526881720430108,
				loadNice: 0,
				loadIdle: 98.9247311827957,
				loadIrq: 0,
				rawLoad: 1000,
				rawLoadUser: 300,
				rawLoadSystem: 700,
				rawLoadNice: 0,
				rawLoadIdle: 92000,
				rawLoadIrq: 0,
			},
		],
	},
	idBuffer: Buffer.from([
		0x31,
		0x30,
		0x30,
		0x30,
		0x30,
		0x30,
		0x30,
		0x30,
		0x30,
		0x31,
		0x62,
		0x39,
		0x33,
		0x66,
		0x33,
		0x66,
		0x00,
	]),
};
const mockFS = [
	{
		fs: 'overlay',
		type: 'overlay',
		size: 30433308672,
		used: 1172959232,
		available: 27684696064,
		use: 4.06,
		mount: '/',
	},
	{
		fs: '/dev/mmcblk0p6',
		type: 'ext4',
		size: 30433308672,
		used: 1172959232,
		available: 27684696064,
		use: 4.06,
		mount: '/data',
	},
	{
		fs: '/dev/mmcblk0p1',
		type: 'vfat',
		size: 41281536,
		used: 7219200,
		available: 34062336,
		use: 17.49,
		mount: '/boot/config.json',
	},
	{
		fs: '/dev/disk/by-state/resin-state',
		type: 'ext4',
		size: 19254272,
		used: 403456,
		available: 17383424,
		use: 2.27,
		mount: '/mnt/root/mnt/state',
	},
	{
		fs: '/dev/disk/by-uuid/ba1eadef-4660-4b03-9e71-9f33257f292c',
		type: 'ext4',
		size: 313541632,
		used: 308860928,
		available: 0,
		use: 100,
		mount: '/mnt/root/mnt/sysroot/active',
	},
	{
		fs: '/dev/mmcblk0p2',
		type: 'ext4',
		size: 313541632,
		used: 299599872,
		available: 0,
		use: 100,
		mount: '/mnt/root/mnt/sysroot/inactive',
	},
];
const mockMemory = {
	total: 4032724992,
	free: 2182356992,
	used: 1850368000,
	active: 459481088,
	available: 3573243904,
	buffers: 186269696,
	cached: 1055621120,
	slab: 252219392,
	buffcache: 1494110208,
	swaptotal: 2016358400,
	swapused: 0,
	swapfree: 2016358400,
};
