// This migration implements the legacy db schema used in supervisors lower than 7.0.0.

// It's a bit ugly for a migration (it's unusual that migrations check for existence of tables and columns)
// but being the first migration for a legacy system, this is the easiest way to bring the db
// to a known schema to start doing proper migrations afterwards.
// For reference, compare this to db.ts in old supervisors (e.g. v6.4.2), but consider we've added
// a few dropColumn and dropTable calls to delete things that were removed throughout the supervisor's
// history without actually adding drop statements (mostly just becoming unused, but still there).

export async function up(knex) {
	const addColumn = async function (table, column, type) {
		const exists = await knex.schema.hasColumn(table, column);
		if (!exists) {
			return knex.schema.table(table, (t) => {
				return t[type](column);
			});
		}
	};
	const dropColumn = async function (table, column) {
		const exists = await knex.schema.hasColumn(table, column);
		if (exists) {
			return knex.schema.table(table, (t) => {
				return t.dropColumn(column);
			});
		}
	};
	const createTableOrRun = async function (
		tableName,
		tableCreator,
		runIfTableExists,
	) {
		const exists = await knex.schema.hasTable(tableName);
		if (!exists) {
			return knex.schema.createTable(tableName, tableCreator);
		} else if (runIfTableExists != null) {
			return runIfTableExists();
		}
	};
	const dropTable = async function (tableName) {
		const exists = await knex.schema.hasTable(tableName);
		if (exists) {
			await knex.schema.dropTable(tableName);
		}
	};
	await Promise.all([
		createTableOrRun('config', (t) => {
			t.string('key').primary();
			t.string('value');
		}),
		createTableOrRun('deviceConfig', (t) => {
			t.json('values');
			t.json('targetValues');
		}).then(async () => {
			const deviceConfigs = await knex('deviceConfig').select();
			if (deviceConfigs.length === 0) {
				await knex('deviceConfig').insert({
					values: '{}',
					targetValues: '{}',
				});
			}
		}),
		createTableOrRun(
			'app',
			(t) => {
				t.increments('id').primary();
				t.string('name');
				t.string('containerName');
				t.string('commit');
				t.string('imageId');
				t.string('appId');
				t.boolean('privileged');
				t.json('env');
				t.json('config');
				t.boolean('markedForDeletion');
			},
			async () => {
				await Promise.all([
					addColumn('app', 'commit', 'string'),
					addColumn('app', 'appId', 'string'),
					addColumn('app', 'containerName', 'string'),
					addColumn('app', 'config', 'json'),
					addColumn('app', 'markedForDeletion', 'boolean'),
					dropColumn('app', 'containerId'),
				]);
				// When updating from older supervisors, config can be null
				await knex('app').update({ config: '{}' }).whereNull('config');
				await knex('app')
					.update({ markedForDeletion: false })
					.whereNull('markedForDeletion');
			},
		),
		createTableOrRun(
			'dependentApp',
			(t) => {
				t.increments('id').primary();
				t.string('appId');
				t.string('parentAppId');
				t.string('name');
				t.string('commit');
				t.string('imageId');
				t.json('config');
				t.json('environment');
			},
			() => {
				return addColumn('dependentApp', 'environment', 'json');
			},
		),
		createTableOrRun(
			'dependentDevice',
			(t) => {
				t.increments('id').primary();
				t.string('uuid');
				t.string('appId');
				t.string('localId');
				t.string('device_type');
				t.string('logs_channel');
				t.string('deviceId');
				t.boolean('is_online');
				t.string('name');
				t.string('status');
				t.string('download_progress');
				t.string('is_managed_by');
				t.dateTime('lock_expiry_date');
				t.string('commit');
				t.string('targetCommit');
				t.json('environment');
				t.json('targetEnvironment');
				t.json('config');
				t.json('targetConfig');
				t.boolean('markedForDeletion');
			},
			() => {
				return Promise.all([
					addColumn('dependentDevice', 'markedForDeletion', 'boolean'),
					addColumn('dependentDevice', 'localId', 'string'),
					addColumn('dependentDevice', 'is_managed_by', 'string'),
					addColumn('dependentDevice', 'lock_expiry_date', 'dateTime'),
				]);
			},
		),
		dropTable('image'),
		dropTable('container'),
	]);
}

export function down() {
	throw new Error('Not implemented');
}
