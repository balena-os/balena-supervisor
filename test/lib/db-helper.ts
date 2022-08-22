import * as constants from '~/lib/constants';
import * as db from '~/src/db';
import * as sinon from 'sinon';

// Creates a test database and returns a query builder
export async function createDB() {
	const oldDatabasePath = process.env.DATABASE_PATH;

	// for testing we use an in memory database
	process.env.DATABASE_PATH = ':memory:';

	// @ts-ignore
	constants.databasePath = process.env.DATABASE_PATH;

	// Cleanup the module cache in order to have it reloaded in the local context
	delete require.cache[require.resolve('~/src/db')];

	// Initialize the database module
	await db.initialized;

	// Get the knex instance to allow queries to the db
	const { models, upsertModel } = db;

	// This is hacky but haven't found another way to do it,
	// stubbing the db methods here ensures the module under test
	// is using the database we want
	sinon.stub(db, 'models').callsFake(models);
	sinon.stub(db, 'upsertModel').callsFake(upsertModel);

	return {
		// Returns a query builder instance for the given
		// table in order perform data operations
		models,

		// Resets the database to initial value post
		// migrations
		async reset() {
			// Reset the contents of the db
			await db.transaction(async (trx: any) => {
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
			// Remove data from the in memory database just in case
			this.reset();

			// Restore the old datbase path
			process.env.DATABASE_PATH = oldDatabasePath;

			// Restore stubs
			(db.models as sinon.SinonStub).restore();
			(db.upsertModel as sinon.SinonStub).restore();

			// Restore the constants
			// @ts-ignore
			constants.databasePath = process.env.DATABASE_PATH;

			// Cleanup the module cache in order to have it reloaded
			// correctly next time it's used
			delete require.cache[require.resolve('~/src/db')];
		},
	};
}

export type TestDatabase = UnwrappedPromise<ReturnType<typeof createDB>>;
