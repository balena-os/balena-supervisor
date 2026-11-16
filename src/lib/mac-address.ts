import _ from 'lodash';
import { promises as fs } from 'fs';
import path from 'path';
import { TypedError } from 'typed-error';

import log from './supervisor-console';
import { shouldReportInterface } from '../network';
import { exists } from './fs-utils';

export class MacAddressError extends TypedError {}

export async function getAll(sysClassNet: string): Promise<string | undefined> {
	try {
		// read the directories in the sysfs...
		const interfaces = await fs.readdir(sysClassNet);

		return _(
			await Promise.all(
				interfaces.map(async (intf) => {
					const ifacePath = path.join(sysClassNet, intf);
					try {
						// Exclude non-directories
						const entryStat = await fs.stat(ifacePath);
						if (!entryStat.isDirectory()) {
							return '';
						}
					} catch {
						// If stat fails ignore the interface
						return '';
					}

					try {
						const [addressFile, typeFile, masterFile] = [
							'address',
							'type',
							'master',
						].map((f) => path.join(ifacePath, f));

						const [intfType, intfHasMaster] = await Promise.all([
							fs.readFile(typeFile, 'utf8'),
							exists(masterFile),
						]);

						// check if we should report this interface at all, or if it is physical interface, or if the interface has a master interface (i.e. it's not the root interface)
						if (
							!shouldReportInterface(intf) ||
							intfType.trim() !== '1' ||
							intfHasMaster
						) {
							// we shouldn't report this MAC address
							return '';
						}

						const addr = await fs.readFile(addressFile, 'utf8');
						return addr.split('\n')[0]?.trim()?.toUpperCase() ?? '';
					} catch (err) {
						log.warn('Error reading MAC address for interface', intf, err);
						return '';
					}
				}),
			),
		)
			.filter((addr) => addr !== '')
			.uniq()
			.join(' ');
	} catch (err) {
		log.error(new MacAddressError(`Unable to acquire MAC address: ${err}`));
		return;
	}
}
