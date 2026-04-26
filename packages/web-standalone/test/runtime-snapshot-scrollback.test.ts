import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')

test('standalone runtime snapshot requests can ask for raw scrollback with sinceSeq', () => {
  const managerSource = fs.readFileSync(path.join(root, 'src/connection-manager.ts'), 'utf8')
  const daemonSource = fs.readFileSync(path.join(root, '../daemon-standalone/src/index.ts'), 'utf8')

  assert.match(managerSource, /options\?: \{ sinceSeq\?: number; force\?: boolean \}/)
  assert.match(managerSource, /searchParams\.set\('sinceSeq', String\(options\.sinceSeq\)\)/)
  assert.match(managerSource, /force: !!options\?\.force/)
  assert.match(daemonSource, /const sinceSeqParam = parsedUrl\.searchParams\.get\('sinceSeq'\)/)
  assert.match(daemonSource, /payload: \{ sessionId, sinceSeq \}/)
})
