import { api } from './api'
import type { AppendOutput, Badge } from './shared'

/**
 * ✅ Verify — automated runtime check of a CDP provider's readChat output:
 * it must return an object with a `messages` array (role + content on every
 * message) and a `status`.
 */
export async function verifyProviderRuntime({ provider, isCdp, cdpConnected, ideTarget, appendOutput, setBadge }: {
  provider: string
  isCdp: boolean
  cdpConnected: boolean
  ideTarget: string
  appendOutput: AppendOutput
  setBadge: (badge: Badge) => void
}) {
  if (!provider) { appendOutput('Select a provider first', 'warn'); return }
  if (!isCdp) { appendOutput('Runtime verification only supports CDP providers', 'warn'); return }
  appendOutput(`🔍 [Verify] Starting automated runtime verification for ${provider}...`, 'log')
  
  try {
    if (!cdpConnected) {
       appendOutput('❌ No CDP connection. Please ensure IDE is running.', 'error')
       return
    }

    appendOutput(`▶ [Verify] Running readChat script...`, 'log')
    const start = Date.now()
    const raw = await api.runScript(provider, 'readChat', undefined, ideTarget || undefined)
    let res = (raw as any)?.result !== undefined ? (raw as any).result : raw
    if (typeof res === 'string') {
      try { res = JSON.parse(res) } catch {}
    }
    
    let pass = true
    if (!res || typeof res !== 'object') {
      appendOutput(`❌ readChat did not return an object. Returned: ${typeof res}`, 'error')
      pass = false
    } else {
      appendOutput(`✅ readChat returned object in ${Date.now()-start}ms`, 'result')
      
      // Assert Messages Array
      if (!Array.isArray(res.messages)) {
        appendOutput(`❌ res.messages is not an array`, 'error')
        pass = false
      } else {
        appendOutput(`✅ Found ${res.messages.length} messages`, 'result')
        
        const parsedTypes: Record<string, number> = { standard: 0, thought: 0, terminal: 0, tool: 0 }
        let hasMissingFields = false
        res.messages.forEach((m: any) => {
           const kind = m.kind || 'standard'
           parsedTypes[kind] = (parsedTypes[kind] || 0) + 1
           if (!m.role || !m.content) hasMissingFields = true
        })
        
        if (hasMissingFields) {
           appendOutput(`❌ Some messages missing 'role' or 'content' fields`, 'error')
           pass = false
        }
        
        appendOutput(`📊 Message kinds: ${JSON.stringify(parsedTypes)}`, 'log')
        if (parsedTypes.thought === 0) appendOutput(`⚠️ No 'thought' blocks found (may be normal if not used)`, 'warn')
        if (parsedTypes.tool === 0) appendOutput(`⚠️ No 'tool' blocks found (may be normal if not used)`, 'warn')
        
        if (res.messages.length > 0) {
          const lastMsg = res.messages[res.messages.length - 1]
          appendOutput(`📝 Latest msg preview (${lastMsg.role}):\n${lastMsg.content.slice(0, 150)}...`, 'log')
        }
      }
      
      // Assert Status
      if (!res.status) {
         appendOutput(`❌ res.status is missing`, 'error')
         pass = false
      } else {
         appendOutput(`✅ Status field found: ${res.status}`, 'result')
      }
    }

    if (pass) {
      appendOutput(`🎉 Runtime Verification Passed! The readChat output is correctly normalized.`, 'result')
      setBadge('ok')
    } else {
      appendOutput(`💥 Runtime Verification Failed. Please fix the provider's readChat script.`, 'error')
      setBadge('err')
    }
  } catch(e: any) {
    appendOutput(`❌ Verification exception: ${e.message}`, 'error')
    setBadge('err')
  }
}
