import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slimSessionLaunchFields } from '../src/tools/mesh-tools-status.js'

// Phase E: mesh_status reports each session's model, its source and the
// thinking level — copied from the daemon's derived session fields; the full
// launch record never enters the coordinator context.
describe('mesh_status session launch fields', () => {
    it('copies model / modelSource / thinkingLevel', () => {
        assert.deepEqual(
            slimSessionLaunchFields({ model: 'opus', modelSource: 'mesh_slot', thinkingLevel: 'high', launch: { model: { history: [] } } }),
            { model: 'opus', modelSource: 'mesh_slot', thinkingLevel: 'high' },
        )
    })

    it('omits absent or non-string fields (older daemons)', () => {
        assert.deepEqual(slimSessionLaunchFields({ id: 's-1' }), {})
        assert.deepEqual(slimSessionLaunchFields({ model: 42, modelSource: '', thinkingLevel: null }), {})
        assert.deepEqual(slimSessionLaunchFields(null), {})
    })
})
