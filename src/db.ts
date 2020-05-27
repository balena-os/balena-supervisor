import * as Knex from 'knex';
import * as path from 'path';
import * as _ from 'lodash';

import * as constants from './lib/constants';

interface DBOpts {
	databasePath?: string;
}

type DBTransactionCallback = (trx: Knex.Transaction) => void;

export type Transaction = Knex.Transaction;

let databasePath: string;
let knex: Knex;

export async function init({ databasePath }: DBOpts = {}): Promise<void> {
	databasePath = databasePath || constants.databasePath;
	knex = Knex({
		client: 'sqlite3',
		connection: {
			filename: databasePath,
		},
		useNullAsDefault: true,
	});
	try {
		await knex('knex_migrations_lock').update({ is_locked: 0 });
	} catch {
		/* ignore */
	}
	return knex.migrate.latest({
		directory: path.join(__dirname, 'migrations'),
	});
}

export function models(modelName: string): Knex.QueryBuilder {
	return knex(modelName);
}

export async function upsertModel(
	modelName: string,
	obj: any,
	id: Dictionary<unknown>,
	trx?: Knex.Transaction,
): Promise<any> {
	const k = trx || knex;

	const n = await k(modelName).update(obj).where(id);
	if (n === 0) {
		return k(modelName).insert(obj);
	}
}

export function transaction(
	cb: DBTransactionCallback,
): Promise<Knex.Transaction> {
	return knex.transaction(cb);
}
