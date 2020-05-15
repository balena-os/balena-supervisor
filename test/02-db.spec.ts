import * as Bluebird from 'bluebird';
import * as Knex from 'knex';
import { fs } from 'mz';

import ChaiConfig = require('./lib/chai-config');
import prepare = require('./lib/prepare');

import { DB } from '../src/db';

const { expect } = ChaiConfig;

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

describe('DB', () => {
	let db: DB;

	before(() => {
		prepare();
		db = new DB();
	});

	it('initializes correctly, running the migrations', () => {
		return expect(db.init()).to.be.fulfilled;
	});

	it('creates a database at the path from an env var', () => {
		const promise = fs.stat(process.env.DATABASE_PATH!);
		return expect(promise).to.be.fulfilled;
	});

	it('creates a database at the path passed on creation', () => {
		const db2 = new DB({ databasePath: process.env.DATABASE_PATH_2 });
		const promise = db2
			.init()
			.then(() => fs.stat(process.env.DATABASE_PATH_2!));
		return expect(promise).to.be.fulfilled;
	});

	it('adds new fields and removes old ones in an old database', async () => {
		const databasePath = process.env.DATABASE_PATH_3!;

		const knexForDB = await createOldDatabase(databasePath);
		const testDb = new DB({ databasePath });
		await testDb.init();
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
		const deviceConfig = await db.models('deviceConfig').select();
		expect(deviceConfig).to.have.lengthOf(1);
		expect(deviceConfig).to.deep.equal([{ targetValues: '{}' }]);
	});

	it('allows performing transactions', () => {
		return db.transaction((trx) => expect(trx.commit()).to.be.fulfilled);
	});
});
