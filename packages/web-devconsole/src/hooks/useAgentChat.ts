import { useEffect, useState } from 'react'
import { api, type ProviderInfo } from '../api'
import type { AppendOutput } from '../shared'

export type AgentChatEntry = { role: 'user' | 'assistant' | 'error'; text: string; elapsed?: number }

/**
 * #3 ACP/CLI chat test ("Chat" tab). CLI providers send through the CLI debug
 * session and poll its debug state until idle; ACP providers use the one-shot
 * acpChat endpoint. History resets when the provider changes.
 */
export function useAgentChat(
  provider: string,
  selectedProvider: ProviderInfo | undefined,
  appendOutput: AppendOutput,
  onCliReplied: () => void,
) {
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<AgentChatEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { setHistory([]) }, [provider])

  async function send() {
    if (!input.trim() || !provider) return
    const msg = input.trim()
    setInput('')
    setHistory(prev => [...prev, { role: 'user', text: msg }])
    setLoading(true)
    try {
      // CLI provider: use /api/cli/send then poll debug for response
      if (selectedProvider?.category === 'cli') {
        const sendResult = await api.cliSend(provider, msg)
        if (!sendResult.sent) {
          setHistory(prev => [...prev, { role: 'error', text: sendResult.error || 'CLI send failed' }])
          appendOutput(`❌ CLI send failed: ${sendResult.error}`, 'error')
        } else {
          appendOutput(`📤 Sent to ${provider}`, 'log')
          // Poll for completion (generating → idle)
          const start = Date.now()
          let response = '(generating...)'
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1000))
            try {
              const dbg = await api.cliDebug(provider)
              if (dbg.debug?.status === 'idle' && dbg.debug?.messageCount > 0) {
                const lastMsg = dbg.debug.messages?.[dbg.debug.messages.length - 1]
                if (lastMsg?.role === 'assistant') {
                  response = lastMsg.content || '(empty response)'
                }
                break
              }
            } catch { /* ignore */ }
          }
          const elapsed = Date.now() - start
          setHistory(prev => [...prev, { role: 'assistant', text: response, elapsed }])
          appendOutput(`💬 [${elapsed}ms] ${response.substring(0, 200)}`, 'result')
          onCliReplied()
        }
      } else {
        // ACP provider: use existing acpChat endpoint
        const result = await api.acpChat(provider, msg)
        if (result.success) {
          setHistory(prev => [...prev, { role: 'assistant', text: result.response || '(no output)', elapsed: result.elapsed }])
          appendOutput(`💬 [${result.elapsed}ms] ${(result.response || '').substring(0, 200)}`, 'result')
        } else {
          setHistory(prev => [...prev, { role: 'error', text: result.error || 'Failed', elapsed: result.elapsed }])
          appendOutput(`❌ Chat failed: ${result.error}`, 'error')
        }
      }
    } catch (e: any) {
      setHistory(prev => [...prev, { role: 'error', text: e.message }])
      appendOutput(`❌ ${e.message}`, 'error')
    }
    setLoading(false)
  }

  return { input, setInput, history, clearHistory: () => setHistory([]), loading, send }
}

export type AgentChatController = ReturnType<typeof useAgentChat>
