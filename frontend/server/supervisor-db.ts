import sqlite3 from 'sqlite3';
sqlite3.verbose();
import * as sqlite from 'sqlite';

import { DATABASE_PATH } from './constants';

let globalKey = '';

/**
 * Open a cached DB connection using sqlite async wrapper and sqlite3 driver
 */
const openDatabaseConnection = async (dbPath): Promise<sqlite.Database<sqlite3.Database, sqlite3.Statement>>|never => {
    try {
        const db = await sqlite.open({
            filename: dbPath,
            mode: sqlite3.OPEN_READONLY,
            driver: sqlite3.cached.Database
        });
        return db;
    } catch (e) {
        // TODO: Better type-safe error handling - neverthrow package?
        console.error(e);
        throw e;
    }
}

/**
 * Get globally scoped Supervisor API key
 * 
 * TODO: This is hacky and not the most secure. We should move to using a
 * scoped API key once Supervisor comes with a docker-compose and local UI
 * is moved to a system app.
 */
export const getGlobalApiKey = async (): Promise<string>|never => {
    if (globalKey) {
        return globalKey;
    }

    try {
        const db = await openDatabaseConnection(DATABASE_PATH);
        const [{key}] = await db.all("SELECT key FROM apiSecret WHERE scopes LIKE '%global%'");
        // Cache queried value, as this won't change unless the Supervisor database is 
        // deleted and we can save some db calls for next time the key is needed.
        // TODO: Handle the case where the Supervisor database is deleted.
        globalKey = key;
        return key;
    } catch (e) {
        // TODO: Better type-safe error handling - neverthrow package?
        console.error(e);
        throw e;
    }
}
