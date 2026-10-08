import assert from 'node:assert/strict'
import test from 'node:test'

import { __resetStandaloneTokenForTests, buildStandaloneUrl, getStandaloneToken } from '../src/standalone-auth-client'

// Live two-machine test (published 1.0.78): after loading /mesh?token=…, clicking a
// sidebar link or "open chat" navigated to /dashboard with no query string, and from
// then on fetch('/api/…') returned 401 because the token was only read from the URL.
function setLocation(pathAndSearch: string): void {
  const url = new URL(pathAndSearch, 'http://127.0.0.1:3871')
  ;(globalThis as any).window = {
    location: { search: url.search, href: url.href, origin: url.origin, pathname: url.pathname, hash: '' },
  }
}

test('token survives in-app navigation that drops the query string', () => {
  __resetStandaloneTokenForTests()
  setLocation('/mesh?token=abc123')
  assert.equal(getStandaloneToken(), 'abc123')
  setLocation('/dashboard')
  assert.equal(getStandaloneToken(), 'abc123')
  assert.equal(buildStandaloneUrl('/api/v1/providers/installed'), '/api/v1/providers/installed?token=abc123')
})

test('a token in the current URL wins over a remembered one', () => {
  __resetStandaloneTokenForTests()
  setLocation('/?token=old')
  getStandaloneToken()
  setLocation('/?token=new')
  assert.equal(getStandaloneToken(), 'new')
})

test('no token anywhere stays null', () => {
  __resetStandaloneTokenForTests()
  setLocation('/dashboard')
  assert.equal(getStandaloneToken(), null)
  assert.equal(buildStandaloneUrl('/api/x'), '/api/x')
  delete (globalThis as any).window
})
