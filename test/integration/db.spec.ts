import Bluebird from 'bluebird';
import { knex, Knex } from 'knex';
import { promises as fs } from 'fs';

import { expect } from 'chai';
import * as constants from '~/lib/constants';

async function createOldDatabase(path: string) {
	const db = knex({
		client: 'sqlite3',
		connection: {
			filename: path,
		},
		useNullAsDefault: true,
	});

	const createEmptyTable = (
		name: string,
		fn: (trx: Knex.CreateTableBuilder) => void,
	) =>
		db.schema.createTable(name, (t) => {
			if (fn != null) {
				return fn(t);
			}
		});

	await createEmptyTable('app', (t) => {
		t.increments('id').primary();
		t.boolean('privileged');
		return t.string('containerId');
	});
	await createEmptyTable('config', (t) => {
		t.string('key');
		return t.string('value');
	});
	await createEmptyTable('dependentApp', (t) => t.increments('id').primary());
	await createEmptyTable('dependentDevice', (t) =>
		t.increments('id').primary(),
	);
	return db;
}

async function restoreDb() {
	await fs.unlink(constants.databasePath).catch(() => {
		/* NOOP */
	});
	// Reset the module cache to allow the database to be initialized again
	delete require.cache[require.resolve('~/src/db')];
}

describe('db', () => {
	afterEach(async () => {
		await restoreDb();
	});

	it('creates a database at the path passed on creation', async () => {
		const testDb = await import('~/src/db');
		await testDb.initialized();
		await expect(fs.access(constants.databasePath)).to.not.be.rejected;
	});

	it('migrations add new fields and removes old ones in an old database', async () => {
		// Create a database with an older schema
		const knexForDB = await createOldDatabase(constants.databasePath);
		const testDb = await import('~/src/db');
		await testDb.initialized();
		await Bluebird.all([
			expect(knexForDB.schema.hasColumn('app', 'appId')).to.eventually.be.true,
			expect(knexForDB.schema.hasColumn('app', 'releaseId')).to.eventually.be
				.true,
			expect(knexForDB.schema.hasColumn('app', 'config')).to.eventually.be
				.false,
			expect(knexForDB.schema.hasColumn('app', 'privileged')).to.eventually.be
				.false,
			expect(knexForDB.schema.hasColumn('app', 'containerId')).to.eventually.be
				.false,
			expect(knexForDB.schema.hasColumn('dependentApp', 'environment')).to
				.eventually.be.true,
			expect(knexForDB.schema.hasColumn('dependentDevice', 'markedForDeletion'))
				.to.eventually.be.true,
			expect(knexForDB.schema.hasColumn('dependentDevice', 'localId')).to
				.eventually.be.true,
			expect(knexForDB.schema.hasColumn('dependentDevice', 'is_managed_by')).to
				.eventually.be.true,
			expect(knexForDB.schema.hasColumn('dependentDevice', 'lock_expiry_date'))
				.to.eventually.be.true,
		]);
	});

	it('creates a deviceConfig table with a single default value', async () => {
		const testDb = await import('~/src/db');
		await testDb.initialized();
		const deviceConfig = await testDb.models('deviceConfig').select();
		expect(deviceConfig).to.have.lengthOf(1);
		expect(deviceConfig).to.deep.equal([{ targetValues: '{}' }]);
	});

	it('allows performing transactions', async () => {
		const testDb = await import('~/src/db');
		await testDb.initialized();
		return testDb.transaction((trx) => expect(trx.commit()).to.be.fulfilled);
	});
});
