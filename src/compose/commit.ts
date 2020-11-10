import * as db from '../db';

const cache: { [appId: number]: string } = {};

export async function getCommitForApp(
	appId: number,
): Promise<string | undefined> {
	if (cache[appId] != null) {
		return cache[appId];
	}

	const commit = await db
		.models('currentCommit')
		.where({ appId })
		.select('commit');

	if (commit?.[0] != null) {
		cache[appId] = commit[0].commit;
		return commit[0].commit;
	}

	return;
}

export function upsertCommitForApp(
	appId: number,
	commit: string,
	trx?: db.Transaction,
): Promise<void> {
	cache[appId] = commit;
	return db.upsertModel('currentCommit', { commit, appId }, { appId }, trx);
}
