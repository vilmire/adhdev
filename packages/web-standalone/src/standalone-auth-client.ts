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

export function getStandaloneToken(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('token')
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
