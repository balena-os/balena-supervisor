import * as systeminformation from 'systeminformation';
import * as osUtils from 'os-utils';
import { fs, child_process } from 'mz';

export function getCpuUsage() {
	return new Promise((resolve) => {
		osUtils.cpuUsage((percent) => {
			resolve(Math.round(percent * 100));
		});
	});
}

const blockDeviceRegex = /(\/dev\/.*)p\d+/;
export async function getStorageInfo() {
	const fsInfo = await systeminformation.fsSize();
	let mainFs: string | undefined;
	let total = 0;
	// First we find the block device which the data partition is part of
	for (const partition of fsInfo) {
		if (partition.mount === '/data') {
			const match = partition.fs.match(blockDeviceRegex);
			if (match == null) {
				mainFs = undefined;
			} else {
				mainFs = match[1];
				total = partition.size;
			}
			break;
		}
	}

	if (!mainFs) {
		return {
			blockDevice: '',
			storageUsed: undefined,
			storageTotal: undefined,
		};
	}

	let used = 0;
	for (const partition of fsInfo) {
		if (partition.fs.startsWith(mainFs)) {
			used += partition.used;
		}
	}

	return {
		blockDevice: mainFs,
		storageUsed: bytesToMb(used),
		storageTotal: bytesToMb(total),
	};
}

export async function getMemoryInformation() {
	const mem = await systeminformation.mem();
	return {
		used: bytesToMb(mem.used),
		total: bytesToMb(mem.total),
	};
}

export async function getCpuTemp() {
	return Math.round((await systeminformation.cpuTemperature()).main);
}

export async function getCpuId() {
	// Read /proc/device-tree/serial-number
	// if it's not there, return undefined
	try {
		const buffer = await fs.readFile('/proc/device-tree/serial-number');
		// Remove the null byte at the end
		return buffer.toString('utf-8').substr(0, buffer.length - 2);
	} catch {
		return undefined;
	}
}

const undervoltageRegex = /under.*voltage/;
export async function undervoltageDetected() {
	try {
		const [dmesgStdout] = await child_process.exec('dmesg');
		return undervoltageRegex.test(dmesgStdout.toString());
	} catch {
		return false;
	}
}

export async function getSysInfoToReport() {
	const [cpu, mem, temp, cpuid, storage, undervoltage] = await Promise.all([
		getCpuUsage(),
		getMemoryInformation(),
		getCpuTemp(),
		getCpuId(),
		getStorageInfo(),
		undervoltageDetected(),
	]);

	return {
		cpu_usage: cpu,
		memory_usage: mem.used,
		memory_total: mem.total,
		storage_usage: storage.storageUsed,
		storage_total: storage.storageTotal,
		storage_block_device: storage.blockDevice,
		cpu_temp: temp,
		cpu_id: cpuid,
		is_undervolted: undervoltage,
	};
}

function bytesToMb(bytes: number) {
	return Math.floor(bytes / 1024 / 1024);
}
