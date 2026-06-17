import { describe, expect, it } from 'vitest'
import { redactLogLine, redactLogLines } from '../../src/logging/log-redactor'

describe('log-redactor', () => {
  it('masks ADHDev API key (adk_), machine secret (adm_), provider key (adp_)', () => {
    const out = redactLogLine('auth ok with adk_ABCDEF1234567890 and adm_SECRETmachine9999 plus adp_providerKEY12345')
    expect(out).not.toContain('adk_ABCDEF1234567890')
    expect(out).not.toContain('adm_SECRETmachine9999')
    expect(out).not.toContain('adp_providerKEY12345')
    // prefix preserved for readability
    expect(out).toContain('adk_')
    expect(out).toContain('adm_')
    expect(out).toContain('adp_')
  })

  it('masks Authorization Bearer token but keeps the prefix', () => {
    const out = redactLogLine('Authorization: Bearer abc123DEF456ghi789JKL')
    expect(out).toContain('Bearer ')
    expect(out).not.toContain('abc123DEF456ghi789JKL')
    expect(out).toContain('redacted')
  })

  it('masks a JWT (eyJ... three-segment)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const out = redactLogLine(`token=${jwt} issued`)
    expect(out).not.toContain(jwt)
    expect(out).toContain('redacted')
    expect(out).toContain('issued')
  })

  it('masks JWT_SECRET=... and generic SECRET/TOKEN/PASSWORD key=value dumps', () => {
    expect(redactLogLine('JWT_SECRET=supersecretvalue123')).not.toContain('supersecretvalue123')
    expect(redactLogLine('TURN_API_TOKEN=tok_abcdef123456')).not.toContain('tok_abcdef123456')
    expect(redactLogLine('password: hunter2hunter2')).not.toContain('hunter2hunter2')
    // the key name itself stays so the line is still diagnosable
    expect(redactLogLine('JWT_SECRET=supersecretvalue123')).toContain('JWT_SECRET=')
  })

  it('masks TURN credential pairs', () => {
    const out = redactLogLine('iceServer username "1717171717" credential "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"')
    expect(out).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ012345')
    expect(out).toContain('credential')

    const rest = redactLogLine('turn cred 1717171717:dGhpc2lzYWxvbmdiYXNlNjRobWFjdmFsdWU=')
    expect(rest).not.toContain('dGhpc2lzYWxvbmdiYXNlNjRobWFjdmFsdWU=')
    expect(rest).toContain('1717171717:')
  })

  it('leaves a clean line untouched', () => {
    const clean = '[12:34:56.789] [INF] [CDP] Connected to cursor on port 9333'
    expect(redactLogLine(clean)).toBe(clean)
  })

  it('handles multibyte/unicode lines without throwing and preserves non-secret text', () => {
    const line = '[12:00:00] [INF] 메시 노드 로그 fetch 완료 token=adk_KOREAN1234567 끝'
    const out = redactLogLine(line)
    expect(out).toContain('메시 노드 로그 fetch 완료')
    expect(out).toContain('끝')
    expect(out).not.toContain('adk_KOREAN1234567')
  })

  it('redactLogLines maps over an array', () => {
    const out = redactLogLines(['adk_TOPSECRET999999', 'plain line', 'Bearer zzzzzzzzzzzzzz'])
    expect(out).toHaveLength(3)
    expect(out[0]).not.toContain('adk_TOPSECRET999999')
    expect(out[1]).toBe('plain line')
    expect(out[2]).not.toContain('zzzzzzzzzzzzzz')
  })
})
