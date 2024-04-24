import { set } from '@balena/es-version';
// Set the desired es version for downstream modules that support it, before we import any
set('es2022');

import { setDefaultAutoSelectFamilyAttemptTimeout } from 'net';
// Increase the timeout for the happy eyeballs algorithm to 5000ms to avoid issues on slower networks
setDefaultAutoSelectFamilyAttemptTimeout(5000);

// Setup MDNS resolution
import './mdns';

import Supervisor from './supervisor';
import process from 'process';
import log from './lib/supervisor-console';

// Register signal handlers before starting the supervisor service
process.on('SIGTERM', () => {
	log.info('Received SIGTERM. Exiting.');

	// This is standard exit code to indicate a graceful shutdown
	// it equals 128 + 15 (the signal code)
	process.exit(143);
});

const supervisor = new Supervisor();
supervisor.init().catch((e) => {
	log.error('Uncaught exception:', e);

	// Terminate the process to avoid leaving the supervisor in a bad state
	process.exit(1);
});
