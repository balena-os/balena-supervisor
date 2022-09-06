import { expect } from 'chai';

import * as commitStore from '~/src/compose/commit';
import * as db from '~/src/db';

describe('compose/commit', () => {
	before(async () => await db.initialized());

	describe('Fetching commits', () => {
		beforeEach(async () => {
			// Clear the commit values in the db
			await db.models('currentCommit').del();
		});

		it('should fetch a commit for an appId', async () => {
			const commit = 'abcdef';
			await commitStore.upsertCommitForApp(1, commit);

			expect(await commitStore.getCommitForApp(1)).to.equal(commit);
		});

		it('should fetch the correct commit value when there is multiple commits', async () => {
			const commit = 'abcdef';
			await commitStore.upsertCommitForApp(1, '123456');
			await commitStore.upsertCommitForApp(2, commit);

			expect(await commitStore.getCommitForApp(2)).to.equal(commit);
		});
	});

	it('should correctly insert a commit when a commit for the same app already exists', async () => {
		const commit = 'abcdef';
		await commitStore.upsertCommitForApp(1, '123456');
		await commitStore.upsertCommitForApp(1, commit);
		expect(await commitStore.getCommitForApp(1)).to.equal(commit);
	});
});
