/**
 * (§8 unit 4c) ChatPane must actually EMIT the read-source readout.
 *
 * `buildTranscriptReadSourceAttributes` is unit-tested next door, but a pure
 * helper nobody spreads onto an element is exactly the failure this unit
 * exists to fix: units 4b/5 computed `transcriptReadSource` correctly and no
 * consumer read it, so the value was right and invisible. A helper with zero
 * call sites would reproduce that precisely — and no rendering test would
 * fail, because the pane renders identically either way.
 *
 * Rendering ChatPane for real would mean standing up the transport, daemon and
 * i18n contexts it consumes — a large harness whose failures would mostly be
 * about the harness. The attribute application is a single spread, so this
 * pins it at the source level instead: cheap, and it fails for exactly one
 * reason.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CHAT_PANE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/components/dashboard/ChatPane.tsx', import.meta.url)),
  'utf8',
)

describe('ChatPane read-source observability (unit 4c)', () => {
  it('★ spreads the read-source attributes onto the pane root', () => {
    expect(CHAT_PANE_SOURCE).toContain('buildTranscriptReadSourceAttributes(chatTailState)')
  })

  it('imports the helper rather than hand-rolling the attribute names', () => {
    // A local re-implementation would drift from the helper the tests pin —
    // notably on the "omit, do not emit empty" rule for the fallback reason.
    expect(CHAT_PANE_SOURCE).toMatch(
      /import \{\s*buildTranscriptReadSourceAttributes\s*\} from '\.\/transcript-chat-pane-adapter'/,
    )
    expect(CHAT_PANE_SOURCE).not.toContain("'data-transcript-read-source':")
  })
})
