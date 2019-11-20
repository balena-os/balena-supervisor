import * as Bluebird from 'bluebird';
import * as Knex from 'knex';
import * as path from 'path';

import * as constants from './lib/constants';

interface DBOpts {
	databasePath?: string;
}

type DBTransactionCallback = (trx: Knex.Transaction) => void;

export type Transaction = Knex.Transaction;

export class DB {
	private databasePath: string;
	private knex: Knex;

	public constructor({ databasePath }: DBOpts = {}) {
		this.databasePath = databasePath || constants.databasePath;
		this.knex = Knex({
			client: 'sqlite3',
			connection: {
				filename: this.databasePath,
			},
			useNullAsDefault: true,
		});
	}

	public init(): Bluebird<void> {
		return Bluebird.resolve(
			this.knex('knex_migrations_lock').update({ is_locked: 0 }),
		)
			.catch(() => {
				return;
			})
			.then(() => {
				return this.knex.migrate.latest({
					directory: path.join(__dirname, 'migrations'),
				});
			});
	}

	public models(modelName: string): Knex.QueryBuilder {
		return this.knex(modelName);
	}

	public upsertModel(
		modelName: string,
		obj: any,
		id: number | Dictionary<unknown>,
		trx?: Knex.Transaction,
	): Bluebird<any> {
		const knex = trx || this.knex;

		return Bluebird.resolve(
			knex(modelName)
				.update(obj)
				.where(id)
				.then((n: number) => {
					if (n === 0) {
						return knex(modelName).insert(obj);
					}
				}),
		);
	}

	public transaction(cb: DBTransactionCallback): Bluebird<Knex.Transaction> {
		return Bluebird.resolve(this.knex.transaction(cb));
	}
}

export default DB;
