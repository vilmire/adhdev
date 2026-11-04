/**
 * Mission and release event seqs are numbered by each daemon's own AUTOINCREMENT,
 * and every reader asks for them inside one project. So two daemons legitimately
 * hold different projects' events with the same number, and a global primary key
 * makes that look like a collision on import. Renumbering would break exposed ids.
 *
 * This rebuilds such a table, only on a target that actually has the overlap, so
 * the exact coordinate is (mesh_id, seq). `row_id` is the local storage key and is
 * never exported. A build that predates this keeps working on the rebuilt table:
 * its INSERT names no seq, and the trigger assigns the next one.
 */
import { initializeHandoffWriteFences } from './write-fence.js';
import { HISTORY_ROW_ID } from './snapshot-export.js';

export const PROJECT_SCOPED_HISTORY_TABLES: ReadonlySet<string> = new Set(['mesh_mission_events', 'mesh_release_events']);

type Db = Parameters<typeof initializeHandoffWriteFences>[0];

function columnsOf(db: Db, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }> {
    return db.prepare(`PRAGMA table_info(${table})`).all();
}

/** The identity an import matches rows on. */
export function historyIdentityColumns(db: Pick<Db, 'prepare'>, table: string): string[] {
    const columns = columnsOf(db as Db, table);
    if (columns.some(c => c.name === HISTORY_ROW_ID)) return ['mesh_id', 'seq'];
    return columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

/** Idempotent. Runs inside the import transaction, so a rollback restores the old shape. */
export function ensureProjectScopedHistory(db: Db, table: string): void {
    if (!PROJECT_SCOPED_HISTORY_TABLES.has(table)) throw new Error(`not a project-scoped history table: ${table}`);
    const columns = columnsOf(db, table);
    if (columns.some(c => c.name === HISTORY_ROW_ID)) return;
    const rest = columns.filter(c => c.name !== 'seq');
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table).map((r: { sql: string }) => r.sql);
    const declared = rest.map(c => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}`);
    const names = rest.map(c => c.name).join(', ');
    db.transaction(() => {
        db.exec(`CREATE TABLE ${table}__scoped (${HISTORY_ROW_ID} INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER, ${declared.join(', ')}, UNIQUE (mesh_id, seq));
            INSERT INTO ${table}__scoped (${HISTORY_ROW_ID}, seq, ${names}) SELECT seq, seq, ${names} FROM ${table};
            DROP TABLE ${table};
            ALTER TABLE ${table}__scoped RENAME TO ${table};
            CREATE INDEX IF NOT EXISTS idx_${table}_seq ON ${table}(seq);
            CREATE TRIGGER ${table}_assign_seq AFTER INSERT ON ${table} WHEN NEW.seq IS NULL BEGIN
                UPDATE ${table} SET seq = MAX(NEW.${HISTORY_ROW_ID}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table})) WHERE ${HISTORY_ROW_ID} = NEW.${HISTORY_ROW_ID};
            END;`);
        for (const sql of indexes) db.exec(sql);
        // Dropping the table dropped its fence triggers. Put them back in this same transaction.
        initializeHandoffWriteFences(db);
    })();
}
