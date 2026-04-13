import { describe, expect, it } from 'vitest'
import {
  flattenMessageParts,
  normalizeInputEnvelope,
  normalizeMessageParts,
} from '../../src/providers/io-contracts.js'

describe('provider io contracts', () => {
  describe('normalizeInputEnvelope', () => {
    it('normalizes plain text input into a text-only envelope', () => {
      expect(normalizeInputEnvelope('hello')).toEqual({
        parts: [{ type: 'text', text: 'hello' }],
        textFallback: 'hello',
      })
    })

    it('normalizes legacy message/text payloads into a text-only envelope', () => {
      expect(normalizeInputEnvelope({ message: 'hello' })).toEqual({
        parts: [{ type: 'text', text: 'hello' }],
        textFallback: 'hello',
      })

      expect(normalizeInputEnvelope({ text: 'world' })).toEqual({
        parts: [{ type: 'text', text: 'world' }],
        textFallback: 'world',
      })
    })

    it('preserves structured input parts and derives a text fallback from text parts', () => {
      expect(normalizeInputEnvelope({
        input: {
          parts: [
            { type: 'text', text: 'describe this image' },
            { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
          ],
        },
      })).toEqual({
        parts: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
        ],
        textFallback: 'describe this image',
      })
    })

    it('uses explicit textFallback when structured input provides one', () => {
      expect(normalizeInputEnvelope({
        input: {
          parts: [{ type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' }],
          textFallback: 'please inspect the attached image',
        },
      })).toEqual({
        parts: [{ type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' }],
        textFallback: 'please inspect the attached image',
      })
    })
  })

  describe('normalizeMessageParts', () => {
    it('wraps strings as text message parts', () => {
      expect(normalizeMessageParts('hello')).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('normalizes current content block arrays and preserves supported media/resource parts', () => {
      expect(normalizeMessageParts([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
        { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/example.mp3' },
        { type: 'resource_link', uri: 'file:///tmp/report.txt', name: 'report.txt' },
        { type: 'resource', resource: { uri: 'file:///tmp/report.txt', text: 'report body' } },
      ])).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
        { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/example.mp3' },
        { type: 'resource_link', uri: 'file:///tmp/report.txt', name: 'report.txt' },
        { type: 'resource', resource: { uri: 'file:///tmp/report.txt', text: 'report body' } },
      ])
    })

    it('supports video message parts for the canonical runtime model', () => {
      expect(normalizeMessageParts([
        { type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/example.mp4', posterUri: 'file:///tmp/example.jpg' },
      ])).toEqual([
        { type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/example.mp4', posterUri: 'file:///tmp/example.jpg' },
      ])
    })
  })

  describe('flattenMessageParts', () => {
    it('joins only text-like content into a plain-text fallback string', () => {
      expect(flattenMessageParts([
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
        { type: 'resource', resource: { uri: 'file:///tmp/report.txt', text: 'body' } },
      ])).toBe('hello\nbody')
    })
  })
})
