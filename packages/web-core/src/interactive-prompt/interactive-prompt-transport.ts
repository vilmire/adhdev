import type { InteractivePromptSession } from './interactive-prompt-utils'
import type { InteractivePromptResponse } from './types'

type SendCommand = (daemonId: string, type: string, payload?: unknown) => Promise<unknown>
type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export interface SubmitInteractivePromptResponseOptions {
  promptSession: InteractivePromptSession
  response: InteractivePromptResponse
  useP2PCommand: boolean
  sendCommand: SendCommand
  fetchImpl?: FetchLike
}

function commandSucceeded(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const body = (response as { result?: unknown }).result ?? response
  return !!body && typeof body === 'object' && (body as { success?: unknown }).success !== false
}

function getCommandError(response: unknown): string {
  const body = (response as { result?: unknown } | null)?.result ?? response
  return typeof (body as { error?: unknown } | null)?.error === 'string'
    ? (body as { error: string }).error
    : 'Interactive prompt response failed'
}

async function postStandaloneInteractivePromptResponse(
  sessionId: string,
  response: InteractivePromptResponse,
  fetchImpl: FetchLike,
): Promise<void> {
  const httpResponse = await fetchImpl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/interactive-prompt/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(response),
  })
  if (!httpResponse.ok) {
    let message = `HTTP ${httpResponse.status}`
    try {
      const body = await httpResponse.json()
      if (typeof body?.error === 'string') message = body.error
    } catch {
      // Keep the status fallback.
    }
    throw new Error(message)
  }
}

export async function submitInteractivePromptResponse({
  promptSession,
  response,
  useP2PCommand,
  sendCommand,
  fetchImpl = fetch,
}: SubmitInteractivePromptResponseOptions): Promise<void> {
  if (useP2PCommand) {
    const result = await sendCommand(promptSession.routeId, 'interactive_prompt_response', {
      targetSessionId: promptSession.sessionId,
      sessionId: promptSession.sessionId,
      response,
    })
    if (!commandSucceeded(result)) {
      throw new Error(getCommandError(result))
    }
    return
  }

  await postStandaloneInteractivePromptResponse(promptSession.sessionId, response, fetchImpl)
}
