import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeTerminalInputForProvider } from '../src/input-sanitizer.ts'

test('sanitizeTerminalInputForProvider removes OSC 11 BEL and ST terminal responses', () => {
  assert.equal(
    sanitizeTerminalInputForProvider('hello\x1b]11;rgb:0f0f/1111/1717\x07world'),
    'helloworld',
  )
  assert.equal(
    sanitizeTerminalInputForProvider('hello\x1b]11;rgb:0f0f/1111/1717\x1b\\world'),
    'helloworld',
  )
})

test('sanitizeTerminalInputForProvider removes guarded bare OSC 11 rgb response fragments', () => {
  assert.equal(
    sanitizeTerminalInputForProvider(']11;rgb:0f0f/1111/1717'),
    '',
  )
  assert.equal(
    sanitizeTerminalInputForProvider('typed\n]11;rgb:0f0f/1111/1717\nmore'),
    'typed\n\nmore',
  )
})

test('sanitizeTerminalInputForProvider preserves normal user input and non-leading OSC-like text', () => {
  assert.equal(
    sanitizeTerminalInputForProvider('normal user input'),
    'normal user input',
  )
  assert.equal(
    sanitizeTerminalInputForProvider('explain ]11;rgb:0f0f/1111/1717 please'),
    'explain ]11;rgb:0f0f/1111/1717 please',
  )
  assert.equal(
    sanitizeTerminalInputForProvider('paste ]11;rgb:zzzz/1111/1717'),
    'paste ]11;rgb:zzzz/1111/1717',
  )
})

test('sanitizeTerminalInputForProvider keeps existing device attribute response filtering', () => {
  assert.equal(
    sanitizeTerminalInputForProvider('before\x1b[?1;2cafter'),
    'beforeafter',
  )
})
