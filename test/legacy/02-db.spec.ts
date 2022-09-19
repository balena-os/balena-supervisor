import * as Bluebird from 'bluebird';
import * as Knex from 'knex';

import { expect } from 'chai';
import prepare = require('~/test-lib/prepare');
import * as constants from '~/lib/constants';
import { exists } from '~/lib/fs-utils';

async function createOldDatabase(path: string) {
	const knex = Knex({
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
		knex.schema.createTable(name, (t) => {
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
	return knex;
}

describe('Database Migrations', () => {
	before(async () => {
		await prepare();
	});

	after(() => {
		// @ts-expect-error
		constants.databasePath = process.env.DATABASE_PATH;
		delete require.cache[require.resolve('~/src/db')];
	});

	it('creates a database at the path passed on creation', async () => {
		const databasePath = process.env.DATABASE_PATH_2!;
		// @ts-expect-error
		constants.databasePath = databasePath;
		delete require.cache[require.resolve('~/src/db')];

		const testDb = await import('~/src/db');
		await testDb.initialized();
		expect(await exists(databasePath)).to.be.true;
	});

	it('adds new fields and removes old ones in an old database', async () => {
		const databasePath = process.env.DATABASE_PATH_3!;

		const knexForDB = await createOldDatabase(databasePath);
		// @ts-expect-error
		constants.databasePath = databasePath;
		delete require.cache[require.resolve('~/src/db')];
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
});

describe('Database', () => {
	let db: typeof import('~/src/db');

	before(async () => {
		await prepare();
		db = await import('~/src/db');
	});
	it('initializes correctly, running the migrations', () => {
		return expect(db.initialized()).to.be.fulfilled;
	});
	it('creates a database at the path from an env var', async () => {
		expect(await exists(process.env.DATABASE_PATH!)).to.be.true;
	});
	it('creates a deviceConfig table with a single default value', async () => {
		const deviceConfig = await db.models('deviceConfig').select();
		expect(deviceConfig).to.have.lengthOf(1);
		expect(deviceConfig).to.deep.equal([{ targetValues: '{}' }]);
	});

	it('allows performing transactions', () => {
		return db.transaction((trx) => expect(trx.commit()).to.be.fulfilled);
	});
});
