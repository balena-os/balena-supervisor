import * as db from '../db';
import type { ExtensionState } from './extensions';

const TABLE = 'extensionState';

interface ExtensionRow {
	serviceName: string;
	image: string;
	imageDigest: string | null;
	deployedAt: string;
}

/**
 * Get all currently deployed extensions from the database.
 */
export async function getDeployedExtensions(): Promise<ExtensionState[]> {
	const rows: ExtensionRow[] = await db.models(TABLE).select('*');
	return rows.map((row) => ({
		serviceName: row.serviceName,
		image: row.image,
		imageDigest: row.imageDigest ?? undefined,
		deployedAt: row.deployedAt,
	}));
}

/**
 * Save or update an extension's deployed state.
 */
export async function upsertExtension(
	state: ExtensionState,
	trx?: db.Transaction,
): Promise<void> {
	await db.upsertModel(
		TABLE,
		{
			serviceName: state.serviceName,
			image: state.image,
			imageDigest: state.imageDigest ?? null,
			deployedAt: state.deployedAt,
		},
		{ serviceName: state.serviceName },
		trx,
	);
}

/**
 * Remove an extension from the deployed state.
 */
export async function removeExtension(
	serviceName: string,
	trx?: db.Transaction,
): Promise<void> {
	const query = db.models(TABLE).where({ serviceName }).del();
	if (trx) {
		await query.transacting(trx);
	} else {
		await query;
	}
}

/**
 * Update the database with the results of an extension deployment.
 * Adds/updates deployed extensions and removes ones that were removed.
 */
export async function updateDeployedExtensions(
	deployed: string[],
	removed: string[],
	extensions: Array<{ serviceName?: string; image: string }>,
): Promise<void> {
	const now = new Date().toISOString();

	await db.transaction(async (trx) => {
		// Remove extensions that were removed
		for (const serviceName of removed) {
			await removeExtension(serviceName, trx);
		}

		// Add/update deployed extensions
		for (const serviceName of deployed) {
			const ext = extensions.find((e) => e.serviceName === serviceName);
			if (ext?.serviceName) {
				await upsertExtension(
					{
						serviceName: ext.serviceName,
						image: ext.image,
						deployedAt: now,
					},
					trx,
				);
			}
		}
	});
}
