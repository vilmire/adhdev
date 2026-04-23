import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CliTerminalPane explicit PTY transport contract', () => {
  it('uses sendPtyInput from TransportContext instead of a sendData/sendCommand fallback chain', () => {
    const paneSource = fs.readFileSync(path.join(import.meta.dirname, '../../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    const transportSource = fs.readFileSync(path.join(import.meta.dirname, '../../../src/context/TransportContext.tsx'), 'utf8')
    const standaloneAppSource = fs.readFileSync(path.join(import.meta.dirname, '../../../../web-standalone/src/App.tsx'), 'utf8')
    const cloudAppSource = fs.readFileSync(path.join(import.meta.dirname, '../../../../../../packages/web-cloud/src/App.tsx'), 'utf8')

    expect(transportSource.includes('sendPtyInput?: (daemonId: string, sessionId: string, data: string) => boolean')).toBe(true)
    expect(standaloneAppSource.includes('sendPtyInput: sendPtyInputViaWs,')).toBe(true)
    expect(cloudAppSource.includes("sendPtyInput: (daemonId: string, sessionId: string, data: string) => p2pManager.sendPtyInput(daemonId, sessionId, data),")).toBe(true)
    expect(paneSource.includes('const { sendPtyInput } = useTransport();')).toBe(true)
    expect(paneSource.includes("const sent = sendPtyInput?.(daemonRouteId, sessionId, data) ?? false;")).toBe(true)
    expect(paneSource.includes("if (!sent) return;" )).toBe(true)
    expect(paneSource.includes("sendData?.(daemonRouteId, { type: 'pty_input'" )).toBe(false)
    expect(paneSource.includes("sendCommand(daemonRouteId, 'pty_input'" )).toBe(false)
  })
})
