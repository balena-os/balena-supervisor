import log from './supervisor-console';
import { singleton, ServiceManager, LoginManager } from '@balena/systemd';
import { setTimeout } from 'timers/promises';

async function startUnit(unitName: string) {
	const bus = await singleton();
	const systemd = new ServiceManager(bus);
	const unit = systemd.getUnit(unitName);
	log.debug(`Starting systemd unit: ${unitName}`);
	await unit.start('fail');
}

export async function restartService(serviceName: string) {
	const bus = await singleton();
	const systemd = new ServiceManager(bus);
	const unit = systemd.getUnit(`${serviceName}.service`);
	log.debug(`Restarting systemd service: ${serviceName}`);
	await unit.restart('fail');
}

export async function startService(serviceName: string) {
	return startUnit(`${serviceName}.service`);
}

export async function startSocket(socketName: string) {
	return startUnit(`${socketName}.socket`);
}

async function stopUnit(unitName: string) {
	const bus = await singleton();
	const systemd = new ServiceManager(bus);
	const unit = systemd.getUnit(unitName);
	log.debug(`Stopping systemd unit: ${unitName}`);
	await unit.stop('fail');
}

export async function stopService(serviceName: string) {
	return stopUnit(`${serviceName}.service`);
}

export async function stopSocket(socketName: string) {
	return stopUnit(`${socketName}.socket`);
}

export async function reboot() {
	// No idea why this timeout is here, my guess
	// is that it is to allow the API reboot endpoint to be able
	// to send a response before the event happens
	await setTimeout(1000);
	const bus = await singleton();
	const logind = new LoginManager(bus);
	try {
		await logind.reboot();
	} catch (e) {
		log.error(`Unable to reboot: ${e}`);
	}
}

export async function shutdown() {
	// No idea why this timeout is here, my guess
	// is that it is to allow the API shutdown endpoint to be able
	// to send a response before the event happens
	await setTimeout(1000);
	const bus = await singleton();
	const logind = new LoginManager(bus);
	try {
		await logind.powerOff();
	} catch (e) {
		log.error(`Unable to shutdown: ${e}`);
	}
}

export async function waitForServiceState(
	serviceName: string,
	targetStates: string[],
	timeoutMs: number = 5 * 60 * 1000,
	pollIntervalMs: number = 500,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await serviceActiveState(serviceName);
		if (targetStates.includes(state)) {
			return state;
		}
		await setTimeout(pollIntervalMs);
	}
	throw new Error(
		`Timed out waiting for ${serviceName}.service to reach one of [${targetStates}]`,
	);
}

export async function serviceActiveState(serviceName: string) {
	const bus = await singleton();
	const systemd = new ServiceManager(bus);
	const unit = systemd.getUnit(`${serviceName}.service`);
	return await unit.activeState;
}

export async function servicePartOf(serviceName: string) {
	const bus = await singleton();
	const systemd = new ServiceManager(bus);
	const unit = systemd.getUnit(`${serviceName}.service`);
	return await unit.partOf;
}
