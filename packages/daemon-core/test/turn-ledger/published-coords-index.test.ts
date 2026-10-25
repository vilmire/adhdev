import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';

// findPublishedEvent runs per delivered notice on every delivery-sweep pass. Without an
// index on the published coordinates SQLite fell back to ix_turn_events_mesh_kind and
// scanned every event of the mesh (~700k on the preview coordinator), pinning the daemon.
describe('turn_events published-coordinate lookup', () => {
    it('uses the published-coords index, with or without the mesh filter', () => {
        const db = new Database(':memory:');
        ensureTurnLedgerSchema(db);
        const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('w', 1, 'm') as Array<{ detail: string }>).map(r => r.detail).join(' | ');
        expect(plan(`SELECT * FROM turn_events WHERE src_writer = ? AND published_seq = ? AND publish_state = 'published' AND mesh_id = ? LIMIT 1`))
            .toContain('ix_turn_events_published_coords');
        const noMesh = (db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM turn_events WHERE src_writer = ? AND published_seq = ? AND publish_state = 'published' LIMIT 1`).all('w', 1) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
        expect(noMesh).toContain('ix_turn_events_published_coords');
        db.close();
    });
});
