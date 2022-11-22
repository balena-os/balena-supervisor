import systeminformation from 'systeminformation';
import _ from 'lodash';
import memoizee from 'memoizee';
import { promises as fs } from 'fs';

// TODO: remove this once we can update Node to v16 and typescript
// to an es2021 compatible version for native Promise.any
import { Promise } from 'bluebird';

import { exec } from './fs-utils';

export async function getCpuUsage(): Promise<number> {
	const cpuData = await systeminformation.currentLoad();
	const totalLoad = _.sumBy(cpuData.cpus, ({ load }) => {
		return load;
	});
	return Math.round(totalLoad / cpuData.cpus.length);
}

export async function getStorageInfo(): Promise<{
	blockDevice: string;
	storageUsed?: number;
	storageTotal?: number;
}> {
	const fsInfo = await systeminformation.fsSize();
	let mainFs: string | undefined;
	let total = 0;
	// First we find the block device which the data partition is part of
	for (const partition of fsInfo) {
		if (partition.mount === '/data') {
			mainFs = partition.fs;
			total = partition.size;
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

export async function getMemoryInformation(): Promise<{
	used: number;
	total: number;
}> {
	const mem = await systeminformation.mem();
	return {
		used: bytesToMb(mem.used - mem.cached - mem.buffers),
		total: bytesToMb(mem.total),
	};
}

export async function getCpuTemp(): Promise<number> {
	const tempInfo = await systeminformation.cpuTemperature();
	return Math.round(tempInfo.main);
}

export async function getSystemId(): Promise<string | undefined> {
	try {
		// This will work on arm devices
		const buffer = await Promise.any([
			fs.readFile('/proc/device-tree/serial-number'),
			fs.readFile('/proc/device-tree/product-sn'),
			fs.readFile('/sys/devices/soc0/serial_number'),
		]);
		// Remove the null/newline bytes at the end
		return buffer.toString('utf-8').replace(/\0/g, '').trim();
	} catch {
		// Otherwise use dmidecode
		const [baseBoardInfo] = (
			await dmidecode('baseboard').catch(() => [] as DmiDecodeInfo[])
		).filter((entry) => entry.type === 'Base Board Information');
		return baseBoardInfo?.values?.['Serial Number'] || undefined;
	}
}

export async function getSystemModel(): Promise<string | undefined> {
	try {
		const buffer = await Promise.any([
			fs.readFile('/proc/device-tree/model'),
			fs.readFile('/proc/device-tree/product-name'),
		]);
		// Remove the null byte at the end
		return buffer.toString('utf-8').replace(/\0/g, '').trim();
	} catch {
		const [baseBoardInfo] = (
			await dmidecode('baseboard').catch(() => [] as DmiDecodeInfo[])
		).filter((entry) => entry.type === 'Base Board Information');

		// Join manufacturer and product name in a single string
		return (
			[
				baseBoardInfo?.values?.['Manufacturer'],
				baseBoardInfo?.values?.['Product Name'],
			]
				.filter((s) => !!s)
				.join(' ') || undefined
		);
	}
}

export type DmiDecodeInfo = { type: string; values: { [key: string]: string } };

/**
 * Parse the output of dmidecode and return an array of
 * objects {type: string, values: string[]}
 *
 * This only parses simple key,value pairs from the output
 * of dmidecode, multiline strings and arrays are ignored
 *
 * The output of the command is memoized
 */
export const dmidecode = memoizee(
	async (t: string): Promise<DmiDecodeInfo[]> => {
		const { stdout: info } = await exec(`dmidecode -t ${t}`);
		return (
			info
				.toString()
				.split(/\r?\n/) // Split by line jumps
				// Split into groups by looking for empty lines
				.reduce((groups, line) => {
					const currentGroup = groups.pop() || [];
					if (/^\s*$/.test(line)) {
						// For each empty line create a new group
						groups.push(currentGroup);
						groups.push([]);
					} else {
						// Otherwise append the line to the group
						currentGroup.push(line);
						groups.push(currentGroup);
					}
					return groups;
				}, [] as string[][])
				// Only select the handles
				.filter((group) => group.length > 1 && /^Handle/.test(group[0]))
				.map(([, type, ...lines]) => ({
					type,
					values: lines
						// Only select lines that match 'key: value', this will exclude multiline strings
						// and arrays (we don't care about those for these purposes)
						.filter((line) => /^\s+[^:]+: .+$/.test(line))
						.map((line) => {
							const [key, value] = line.split(':').map((s) => s.trim());
							// Finally convert the lines into key value pairs
							return { [key]: value };
						})
						// And merge
						.reduce((vals, v) => ({ ...vals, ...v }), {}),
				}))
		);
	},
	{ promise: true },
);

const undervoltageRegex = /under.*voltage/i;
export async function undervoltageDetected(): Promise<boolean> {
	try {
		const { stdout: dmesgStdout } = await exec('dmesg');
		return undervoltageRegex.test(dmesgStdout.toString());
	} catch {
		return false;
	}
}

/**
 * System metrics that are always reported in current state
 * due to their importance, regardless of HARDWARE_METRICS
 */
export async function getSystemChecks() {
	// TODO: feature - add more eager diagnostic style metrics here,
	// such as fs corruption checks, network issues, etc.
	const undervoltage = await undervoltageDetected();

	return {
		is_undervolted: undervoltage,
	};
}

/**
 * Metrics that would be reported in current state only
 * when HARDWARE_METRICS config var is true.
 */
export async function getSystemMetrics() {
	const [cpu, mem, temp, cpuid, storage] = await Promise.all([
		getCpuUsage(),
		getMemoryInformation(),
		getCpuTemp(),
		getSystemId(),
		getStorageInfo(),
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
	};
}

type SystemChecks = UnwrappedPromise<ReturnType<typeof getSystemChecks>>;

type SystemMetrics = UnwrappedPromise<ReturnType<typeof getSystemMetrics>>;

export type SystemInfo = SystemChecks & SystemMetrics;

const significantChange: { [key in keyof SystemInfo]?: number } = {
	cpu_usage: 20,
	cpu_temp: 5,
	memory_usage: 10,
};

export function isSignificantChange(
	key: string,
	past: number | undefined,
	current: number,
): boolean {
	// If we didn't have a value for this in the past, include it
	if (past == null) {
		return true;
	}
	const bucketSize = significantChange[key as keyof SystemInfo];
	// If we don't have any requirements on this value, include it
	if (bucketSize == null) {
		return true;
	}
	// If the `current` parameter is null, HARDWARE_METRICS has been toggled false
	// and we should include this value for the null metrics patch to the API
	if (current === null) {
		return true;
	}

	return Math.floor(current / bucketSize) !== Math.floor(past / bucketSize);
}

export function bytesToMb(bytes: number) {
	return Math.floor(bytes / 1024 / 1024);
}
