import Docker from 'dockerode';
import _ from 'lodash';

export async function setupLogs(
	docker: Docker,
	containerId: string,
	lastReadTimestamp = 0,
) {
	const container = docker.getContainer(containerId);

	const stream = await container.logs({
		stdout: true,
		stderr: true,
		follow: true,
		timestamps: true,
		since: lastReadTimestamp,
	});

	stream.on('data', chunk => {
		const { message, timestamp } = extractMessage(chunk);
		// Add one here, other we can end up constantly reading
		// the same log line
		lastReadTimestamp = Math.floor(timestamp.getTime() / 1000) + 1;
		process.stdout.write(message);
	});

	// This happens when a container is restarted
	stream.on('end', () => {
		setupLogs(docker, containerId, lastReadTimestamp);
	});
}

function extractMessage(msgBuf: Buffer) {
	// Non-tty message format from:
	// https://docs.docker.com/engine/api/v1.30/#operation/ContainerAttach
	if ([0, 1, 2].includes(msgBuf[0])) {
		// Take the header from this message, and parse it as normal
		msgBuf = msgBuf.slice(8);
	}
	const str = msgBuf.toString();
	const space = str.indexOf(' ');
	return {
		timestamp: new Date(str.slice(0, space)),
		message: str.slice(space + 1),
	};
}
