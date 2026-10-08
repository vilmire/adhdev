import type { StandaloneFontPreferences } from './standalone-font-preferences'

export interface StandaloneAuthSessionStatus {
  required: boolean
  authenticated: boolean
  hasTokenAuth: boolean
  hasPasswordAuth: boolean
  publicHostWarning: boolean
  boundHost: string
}

export interface StandalonePreferencesStatus {
  standaloneBindHost: '127.0.0.1' | '0.0.0.0'
  currentBindHost: string
  standaloneFontPreferences: StandaloneFontPreferences
  hasPasswordAuth: boolean
  hasTokenAuth: boolean
  publicHostWarning: boolean
}

// The dashboard is opened as `/?token=…`, but in-app navigation (sidebar links,
// "open chat", react-router navigate()) replaces the URL without the query string.
// Reading the token only from the live URL therefore lost it after the first click:
// later /api/ fetches went out unauthenticated (401) and a reconnecting transcript
// WebSocket was refused. Remember the token for the page's lifetime once seen.
let rememberedToken: string | null = null

export function getStandaloneToken(): string | null {
  if (typeof window === 'undefined') return null
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) rememberedToken = fromUrl
  return fromUrl || rememberedToken
}

/** Test seam: forget the remembered token. */
export function __resetStandaloneTokenForTests(): void {
  rememberedToken = null
}

export function buildStandaloneUrl(input: string): string {
  if (typeof window === 'undefined') return input
  const url = input.startsWith('http://') || input.startsWith('https://')
    ? new URL(input)
    : new URL(input, window.location.origin)
  const token = getStandaloneToken()
  if (token && !url.searchParams.has('token')) {
    url.searchParams.set('token', token)
  }
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return url.toString()
  }
  return `${url.pathname}${url.search}${url.hash}`
}

export async function standaloneFetch(input: string, init?: RequestInit): Promise<Response> {
  return await fetch(buildStandaloneUrl(input), {
    credentials: 'same-origin',
    ...init,
  })
}

export function stripStandaloneTokenFromLocation(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('token')) return
  url.searchParams.delete('token')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}
