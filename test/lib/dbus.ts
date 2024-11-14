import { exec } from '~/lib/fs-utils';

export async function dbusSend(
	dest: string,
	path: string,
	message: string,
	...contents: string[]
) {
	const { stdout, stderr } = await exec(
		[
			'dbus-send',
			'--system',
			`--dest=${dest}`,
			'--print-reply',
			path,
			message,
			...contents,
		].join(' '),
		{ encoding: 'utf8' },
	);

	if (stderr) {
		throw new Error(stderr);
	}

	// Remove first line, trim each line, and join them back together
	return stdout
		.split(/\r?\n/)
		.slice(1)
		.map((s) => s.trim())
		.join('');
}
