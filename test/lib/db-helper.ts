import * as constants from '../../src/lib/constants';
import * as db from '../../src/db';
import * as sinon from 'sinon';

import rewire = require('rewire');

// Creates a test database and returns a query builder
export async function createDB() {
	const oldDatabasePath = process.env.DATABASE_PATH;

	// for testing we use an in memory database
	process.env.DATABASE_PATH = ':memory:';

	// @ts-ignore
	constants.databasePath = process.env.DATABASE_PATH;

	// Cleanup the module cache in order to have it reloaded in the local context
	delete require.cache[require.resolve('../../src/db')];
	const testDb = rewire('../../src/db');

	// Initialize the database module
	await testDb.initialized;

	// Get the knex instance to allow queries to the db
	const knex = testDb.__get__('knex');
	const { models } = testDb;

	// This is hacky but haven't found another way to do it,
	// stubbing the db methods here ensures the module under test
	// is using the database we want
	sinon.stub(db, 'models').callsFake(models);
	sinon.stub(db, 'upsertModel').callsFake(testDb.upsertModel);

	return {
		// Returns a query builder instance for the given
		// table in order perform data operations
		models,

		// Resets the database to initial value post
		// migrations
		async reset() {
			// Reset the contents of the db
			await testDb.transaction(async (trx: any) => {
				const result = await trx.raw(`
			SELECT name, sql
			FROM sqlite_master
			WHERE type='table'`);
				for (const r of result) {
					// We don't run the migrations again
					if (r.name !== 'knex_migrations') {
						await trx.raw(`DELETE FROM ${r.name}`);
					}
				}

				// The supervisor expects this value to already have
				// been pre-populated
				await trx('deviceConfig').insert({ targetValues: '{}' });
			});

			// Reset stub call history
			(db.models as sinon.SinonStub).resetHistory();
			(db.upsertModel as sinon.SinonStub).resetHistory();
		},

		// Destroys the in-memory database and resets environment
		async destroy() {
			await knex.destroy();

			// Restore the old datbase path
			process.env.DATABASE_PATH = oldDatabasePath;

			// Restore stubs
			(db.models as sinon.SinonStub).restore();
			(db.upsertModel as sinon.SinonStub).restore();

			// @ts-ignore
			constants.databasePath = process.env.DATABASE_PATH;
		},
	};
}

export type TestDatabase = UnwrappedPromise<ReturnType<typeof createDB>>;
