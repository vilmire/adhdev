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

import type { IncomingMessage } from 'http';
import * as os from 'os';
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

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

function normalizeHostCandidate(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) {
    host = host.slice(0, zoneIdx);
  }
  if (host.startsWith('::ffff:')) {
    host = host.slice(7);
  }
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  return host;
}

function parseHostHeaderHostname(rawHostHeader: string): string | null {
  const trimmed = rawHostHeader.trim();
  if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return null;
    }
    const normalized = normalizeHostCandidate(parsed.hostname);
    return normalized || null;
  } catch {
    return null;
  }
}

function isNonLoopbackSocketPeer(req: IncomingMessage): boolean {
  const raw = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '';
  if (!raw) return false;
  const normalized = normalizeHostCandidate(raw);
  if (!normalized) return false;
  return normalized !== '::1' && !normalized.startsWith('127.');
}

function collectAllowedStandaloneHosts(
  listenHost: string,
  req: IncomingMessage,
  extraAllowedHosts?: Iterable<string>,
): Set<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTNAMES);
  const normalizedListen = normalizeHostCandidate(listenHost || '');
  if (normalizedListen && !PUBLIC_ANY_ADDRESSES.has(normalizedListen)) {
    allowed.add(normalizedListen);
  }
  const localAddr = typeof req.socket?.localAddress === 'string'
    ? normalizeHostCandidate(req.socket.localAddress)
    : '';
  if (localAddr && !PUBLIC_ANY_ADDRESSES.has(localAddr)) {
    allowed.add(localAddr);
  }
  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries || []) {
        if (!net?.address) continue;
        const addr = normalizeHostCandidate(net.address);
        if (addr && !PUBLIC_ANY_ADDRESSES.has(addr)) {
          allowed.add(addr);
        }
      }
    }
  } catch {
    // ignore os.networkInterfaces errors in restricted sandboxes
  }
  try {
    const machineHost = normalizeHostCandidate(os.hostname());
    if (machineHost) {
      allowed.add(machineHost);
      if (machineHost.endsWith('.local')) {
        const shortHost = machineHost.slice(0, -'.local'.length);
        if (shortHost) allowed.add(shortHost);
      } else if (!machineHost.includes('.')) {
        allowed.add(`${machineHost}.local`);
      }
    }
  } catch {
    // ignore os.hostname errors
  }
  const configuredList: string[] = [];
  const envAllowed = process.env.ADHDEV_STANDALONE_ALLOWED_HOSTS;
  if (typeof envAllowed === 'string' && envAllowed.trim()) {
    configuredList.push(...envAllowed.split(','));
  }
  if (extraAllowedHosts) {
    for (const item of extraAllowedHosts) {
      if (typeof item === 'string') configuredList.push(item);
    }
  }
  for (const rawEntry of configuredList) {
    const trimmed = rawEntry.trim();
    if (!trimmed) continue;
    const parsedEntry = parseHostHeaderHostname(trimmed.replace(/^https?:\/\//i, ''))
      ?? normalizeHostCandidate(trimmed);
    if (parsedEntry && !PUBLIC_ANY_ADDRESSES.has(parsedEntry)) {
      allowed.add(parsedEntry);
    }
  }
  return allowed;
}

/**
 * Validate the HTTP / WS `Host` header against this daemon's allow-list to
 * block DNS rebinding (`Host: rebind.example:3847` after DNS flips to
 * `127.0.0.1`). Allowed hosts:
 *   - `localhost`, `127.0.0.1`, `[::1]` (`::1`) — restricted to loopback
 *     peers when bound to `0.0.0.0` / `::` so a LAN peer cannot spoof them
 *   - the configured bind address (`listenHost`)
 *   - this machine's own network interface addresses and hostname(s)
 *   - any explicitly configured allowed hosts (`allowedHosts` /
 *     `ADHDEV_STANDALONE_ALLOWED_HOSTS`)
 */
function isStandaloneHostAllowed(input: {
  req: IncomingMessage;
  listenHost: string;
  allowedHosts?: Iterable<string>;
}): boolean {
  const { req, listenHost, allowedHosts } = input;
  const rawHostHeader = req.headers.host;
  if (rawHostHeader === undefined) {
    // Synthetic in-process test mocks that omit an HTTP parser have neither
    // `httpVersion` nor `Origin`; real HTTP/1.1 requests must carry `Host`.
    return !req.httpVersion && req.headers.origin === undefined;
  }
  if (typeof rawHostHeader !== 'string') return false;
  const requestHostname = parseHostHeaderHostname(rawHostHeader);
  if (!requestHostname) return false;
  const normalizedListen = normalizeHostCandidate(listenHost || '');
  if (
    LOOPBACK_HOSTNAMES.has(requestHostname)
    && PUBLIC_ANY_ADDRESSES.has(normalizedListen)
    && isNonLoopbackSocketPeer(req)
  ) {
    return false;
  }
  const allowed = collectAllowedStandaloneHosts(listenHost, req, allowedHosts);
  return allowed.has(requestHostname);
}

/**
 * Validate both `Host` (DNS rebinding guard) and `Origin` (cross-origin guard)
 * for HTTP requests and WebSocket upgrades.
 */
function isStandaloneOriginAllowed(input: {
  req: IncomingMessage;
  listenHost: string;
  allowedHosts?: Iterable<string>;
}): boolean {
  const { req, listenHost, allowedHosts } = input;
  if (!isStandaloneHostAllowed({ req, listenHost, allowedHosts })) return false;
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    const originHostname = normalizeHostCandidate(origin.hostname || '');
    if (!originHostname) return false;
    const normalizedListen = normalizeHostCandidate(listenHost || '');
    const isLoopbackOrigin = LOOPBACK_HOSTNAMES.has(originHostname);
    if (isLoopbackOrigin && PUBLIC_ANY_ADDRESSES.has(normalizedListen) && isNonLoopbackSocketPeer(req)) {
      return false;
    }
    const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
    const parsedHost = rawHost ? new URL(`http://${rawHost}`) : null;
    if (parsedHost && origin.host.toLowerCase() === parsedHost.host.toLowerCase()) {
      return true;
    }
    const requestHostname = rawHost ? parseHostHeaderHostname(rawHost) : null;
    // Vite dev server (3000) and our own served dashboard ports we know
    // about. Only honor when the request is coming TO a loopback bind (never 0.0.0.0 / ::).
    if (
      isLoopbackOrigin
      && (normalizedListen === '127.0.0.1' || normalizedListen === 'localhost' || normalizedListen === '::1')
      && (!requestHostname || LOOPBACK_HOSTNAMES.has(requestHostname))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
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
  isStandaloneHostAllowed,
  isStandaloneOriginAllowed,
};
export type { StandalonePasswordConfig };
