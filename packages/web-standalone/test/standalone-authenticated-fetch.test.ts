import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Live two-machine test (published 1.0.78): on a daemon started with --token, the
// first-run onboarding dialog showed "registry load failed: HTTP 401" because
// StandaloneOnboarding / OnboardingGate called the daemon's /api/ routes with a bare
// fetch() that drops the ?token= the rest of the dashboard forwards. Every same-origin
// /api/ call must go through standaloneFetch (or an equivalent authenticated client).
const SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

test('no bare fetch() of a same-origin /api/ route in web-standalone src', () => {
  const files = sourceFiles(SRC)
  assert.ok(files.length > 10, `expected to scan the web-standalone sources, got ${files.length}`)
  const offenders: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/(^|[^A-Za-z0-9_.])fetch\(\s*[`'"]\/api\//.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [])
})
