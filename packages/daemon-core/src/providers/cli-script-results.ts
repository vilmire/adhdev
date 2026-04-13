export function parseCliScriptResult(result: unknown): { success: boolean; payload: any } {
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (parsed && typeof parsed === 'object' && parsed.success === false) {
        return { success: false, payload: parsed }
      }
      return { success: true, payload: parsed }
    } catch {
      return { success: true, payload: { result } }
    }
  }

  if (result && typeof result === 'object' && 'success' in result && result.success === false) {
    return { success: false, payload: result }
  }

  return { success: true, payload: result }
}

export function getCliScriptCommand(payload: any): { type: string; text?: string } | null {
  if (!payload || typeof payload !== 'object') return null

  if (typeof payload.sendMessage === 'string' && payload.sendMessage.trim()) {
    return { type: 'send_message', text: payload.sendMessage.trim() }
  }

  const command = payload.command
  if (!command || typeof command !== 'object') return null
  if (command.type !== 'send_message' && command.type !== 'pty_write') return null

  const text = typeof command.text === 'string'
    ? command.text.trim()
    : typeof command.message === 'string'
      ? command.message.trim()
      : ''
  if (!text) return null
  return { type: command.type, text }
}
