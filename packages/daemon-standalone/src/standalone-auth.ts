/**
 * daemon-standalone — local auth, session-cookie and on-disk preference helpers.
 *
 * Pure move out of index.ts (2026-09-18, file-size gate decomposition): this is
 * the self-contained standalone-auth concern — password record hashing, the
 * password/preference config files under the pinned ADHDEV_CONFIG_DIR, the
 * in-memory session store, cookie parse/build, and the single
 * request-authenticated predicate the HTTP + WS paths share.
 *
 * Nothing here touches the server class or the entry bootstrap; index.ts
 * re-exports the whole surface so importers and source-shape guards that read
 * index.ts for server/topic symbols are unaffected.
 */

import * as path from 'path';
import * as fs from 'fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { getConfigDir } from '@adhdev/daemon-core';
import {
  loadStandalonePreferences,
  saveStandalonePreferences,
  type StandaloneFontPreferences,
  type StandaloneBindHost,
} from './standalone-preferences.js';
import { PUBLIC_ANY_ADDRESSES } from './standalone-cli-args.js';

const STANDALONE_AUTH_SESSION_COOKIE = 'adhdev_standalone_session';
const STANDALONE_PASSWORD_CONFIG_FILE = 'standalone-auth.json';
const STANDALONE_PREFERENCES_CONFIG_FILE = 'standalone-network.json';
const STANDALONE_BIND_HOST_DEFAULT: StandaloneBindHost = '127.0.0.1';
const PASSWORD_KEYLEN = 64;
const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface StandalonePasswordConfig {
  passwordHash: string;
  passwordSalt: string;
  updatedAt: string;
}

function getStandalonePasswordConfigPath(): string {
  // Instance-scoped: follows the pinned ADHDEV_CONFIG_DIR (see
  // bootstrap-config-dir) so the standalone password never lands in another
  // instance's config dir. Default standalone instance → ~/.adhdev-standalone.
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, STANDALONE_PASSWORD_CONFIG_FILE);
}

function getStandaloneConfigJsonPath(): string {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, STANDALONE_PREFERENCES_CONFIG_FILE);
}

function loadStandaloneBindHostPreference(): StandaloneBindHost {
  return loadStandalonePreferences(getStandaloneConfigJsonPath()).standaloneBindHost;
}

function loadStandaloneFontPreferences(): StandaloneFontPreferences {
  return loadStandalonePreferences(getStandaloneConfigJsonPath()).standaloneFontPreferences;
}

function saveStandaloneBindHostPreference(bindHost: StandaloneBindHost): StandaloneBindHost {
  return saveStandalonePreferences(getStandaloneConfigJsonPath(), { standaloneBindHost: bindHost }).standaloneBindHost;
}

function saveStandaloneFontPreferences(fontPreferences: StandaloneFontPreferences): StandaloneFontPreferences {
  return saveStandalonePreferences(getStandaloneConfigJsonPath(), { standaloneFontPreferences: fontPreferences }).standaloneFontPreferences;
}

function createPasswordRecord(password: string, salt = randomBytes(16).toString('hex')): StandalonePasswordConfig {
  return {
    passwordHash: scryptSync(`${password || ''}`, salt, PASSWORD_KEYLEN).toString('hex'),
    passwordSalt: salt,
    updatedAt: new Date().toISOString(),
  };
}

function verifyPassword(password: string, config: StandalonePasswordConfig | null | undefined): boolean {
  if (!config?.passwordHash || !config.passwordSalt) return false;
  const actual = Buffer.from(scryptSync(`${password || ''}`, config.passwordSalt, PASSWORD_KEYLEN).toString('hex'), 'utf8');
  const expected = Buffer.from(config.passwordHash, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function loadStandalonePasswordConfig(filePath = getStandalonePasswordConfigPath()): StandalonePasswordConfig | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.passwordHash !== 'string' || typeof parsed.passwordSalt !== 'string') return null;
    return {
      passwordHash: parsed.passwordHash,
      passwordSalt: parsed.passwordSalt,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function saveStandalonePasswordConfig(filePath: string, config: StandalonePasswordConfig): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function clearStandalonePasswordConfig(filePath = getStandalonePasswordConfigPath()): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function shouldWarnForPublicUnauthenticatedHost(input: { host: string; hasTokenAuth: boolean; hasPasswordAuth: boolean }): boolean {
  // PUBLIC_ANY_ADDRESSES covers both any-addresses (0.0.0.0 and IPv6 ::) — an
  // explicit --host :: opt-in must not dodge the unauthenticated-public warning.
  return PUBLIC_ANY_ADDRESSES.has(input.host) && !input.hasTokenAuth && !input.hasPasswordAuth;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const eq = part.indexOf('=');
      if (eq === -1) return [part, ''];
      return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
    })
  );
}

function buildSessionCookie(sessionId: string, secure: boolean, maxAgeMs = DEFAULT_SESSION_TTL_MS): string {
  const parts = [
    `${STANDALONE_AUTH_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearedSessionCookie(secure: boolean): string {
  return buildSessionCookie('', secure, 0);
}

class StandaloneSessionStore {
  private sessions = new Map<string, number>();

  create(ttlMs = DEFAULT_SESSION_TTL_MS): string {
    const id = randomBytes(24).toString('hex');
    this.sessions.set(id, Date.now() + ttlMs);
    return id;
  }

  has(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  revoke(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

function isStandaloneRequestAuthenticated(input: {
  configuredToken: string | null;
  passwordConfig: StandalonePasswordConfig | null;
  bearerToken: string | null;
  queryToken: string | null;
  cookieHeader?: string;
  sessionStore: StandaloneSessionStore;
}): boolean {
  const hasTokenAuth = !!input.configuredToken;
  const hasPasswordAuth = !!input.passwordConfig;
  if (!hasTokenAuth && !hasPasswordAuth) return true;
  if (hasTokenAuth && (input.bearerToken === input.configuredToken || input.queryToken === input.configuredToken)) {
    return true;
  }
  if (hasPasswordAuth) {
    const cookies = parseCookies(input.cookieHeader);
    return input.sessionStore.has(cookies[STANDALONE_AUTH_SESSION_COOKIE]);
  }
  return false;
}

export {
  STANDALONE_AUTH_SESSION_COOKIE,
  STANDALONE_PASSWORD_CONFIG_FILE,
  STANDALONE_PREFERENCES_CONFIG_FILE,
  STANDALONE_BIND_HOST_DEFAULT,
  PASSWORD_KEYLEN,
  DEFAULT_SESSION_TTL_MS,
  getStandalonePasswordConfigPath,
  getStandaloneConfigJsonPath,
  loadStandaloneBindHostPreference,
  loadStandaloneFontPreferences,
  saveStandaloneBindHostPreference,
  saveStandaloneFontPreferences,
  createPasswordRecord,
  verifyPassword,
  loadStandalonePasswordConfig,
  saveStandalonePasswordConfig,
  clearStandalonePasswordConfig,
  shouldWarnForPublicUnauthenticatedHost,
  parseCookies,
  buildSessionCookie,
  buildClearedSessionCookie,
  StandaloneSessionStore,
  isStandaloneRequestAuthenticated,
};
export type { StandalonePasswordConfig };
