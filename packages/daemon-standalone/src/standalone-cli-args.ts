/**
 * standalone-cli-args — canonical CLI contract for the standalone server.
 *
 * One parser shared by `main()` and the tests. The security-critical rule:
 * `--host`/`-H` takes an EXPLICIT address (IPv4, IPv6, or "localhost") and the
 * server binds exactly that address. There is no boolean coercion: a bare
 * `--host` (missing value) or an unrecognized value is a visible startup
 * failure — the server never starts on a bind the operator did not ask for.
 *
 * Public binding remains an explicit, documented opt-in: `--host 0.0.0.0`
 * (or the IPv6 any-address `::`) binds all interfaces and keeps the existing
 * unauthenticated-public warning in the startup banner.
 */

import { isIP } from 'net';

export interface StandaloneCliOptions {
  port?: number;
  host?: string;
  publicDir?: string;
  open?: boolean;
  token?: string;
  dev?: boolean;
}

export interface ParsedStandaloneCliArgs {
  options: StandaloneCliOptions;
  /** True when --host/-H was given explicitly (skips the persisted bind-host preference). */
  hostExplicit: boolean;
  showHelp: boolean;
}

export class StandaloneCliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneCliArgsError';
  }
}

export const STANDALONE_HELP_TEXT = `
Usage: adhdev-standalone [options]
       adhdev-standalone list [--all]
       adhdev-standalone attach <sessionId> [--read-only|--takeover]

Options:
  --port, -p <port>      Port to run the standalone server on (default: 3847)
  --host, -H <address>   Bind to an explicit address: an IPv4 address, an IPv6
                         address, or "localhost". Default: 127.0.0.1 (loopback
                         only). Use --host 0.0.0.0 to opt into public/LAN
                         binding — a warning is printed when no auth is set.
  --token <token>        Set an authentication token for the dashboard UI
  --dev                  Enable DevConsole to debug and test providers
  --public <path>        Custom path to the web dashboard distribution
  --no-open              Do not automatically open the browser on startup

Environment:
  ADHDEV_SESSION_HOST_NAME   Override session host namespace (default: adhdev-standalone)
  --help, -h             Show this help message

Runtime commands:
  list, runtimes      Show hosted CLI runtimes
  attach              Attach local terminal to a runtime
  open                Open a local terminal window running adhmux for a runtime
`;

/** Hosts that bind every interface (public opt-in). Used by the startup warning. */
export const PUBLIC_ANY_ADDRESSES = new Set(['0.0.0.0', '::']);

/**
 * Validate an explicit --host value. Deliberate, documented behavior:
 *  - "localhost" (any case) is accepted as the loopback alias.
 *  - Any address Node's net.isIP recognizes is accepted: dotted IPv4 and bare
 *    IPv6 (including ::1 and the public any-addresses 0.0.0.0 / ::).
 *  - Everything else (hostnames, bracketed IPv6, empty strings, typos like
 *    "0.0.0.0.0") is rejected — never silently coerced to 0.0.0.0.
 */
export function normalizeStandaloneHostAddress(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new StandaloneCliArgsError('Missing value for --host. Expected an IPv4 address, an IPv6 address, or "localhost".');
  }
  if (value.toLowerCase() === 'localhost') return 'localhost';
  if (isIP(value) !== 0) return value;
  throw new StandaloneCliArgsError(
    `Invalid --host address "${value}". Expected an IPv4 address (e.g. 127.0.0.1 or 0.0.0.0), an IPv6 address (e.g. ::1), or "localhost".`,
  );
}

function normalizeStandalonePort(raw: string): number {
  const value = String(raw ?? '').trim();
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StandaloneCliArgsError(`Invalid --port value "${value}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

interface FlagSpec {
  names: readonly string[];
  takesValue: boolean;
}

const FLAG_SPECS: readonly FlagSpec[] = [
  { names: ['--port', '-p'], takesValue: true },
  { names: ['--host', '-H'], takesValue: true },
  { names: ['--token'], takesValue: true },
  { names: ['--public'], takesValue: true },
  { names: ['--no-open'], takesValue: false },
  { names: ['--dev'], takesValue: false },
  { names: ['--help', '-h'], takesValue: false },
];

function isKnownFlag(token: string): boolean {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  return FLAG_SPECS.some(spec => spec.names.includes(name));
}

/**
 * Parse argv (already sliced past node + script). Throws
 * StandaloneCliArgsError on any malformed input: missing flag values, invalid
 * --host/--port values, or unknown --flags. Nothing is silently coerced.
 */
export function parseStandaloneCliArgs(args: readonly string[]): ParsedStandaloneCliArgs {
  const options: StandaloneCliOptions = {};
  let hostExplicit = false;
  let showHelp = false;

  const readValue = (flag: string, inlineValue: string | undefined, index: number): { value: string; consumedNext: boolean } => {
    if (inlineValue !== undefined) return { value: inlineValue, consumedNext: false };
    const next = args[index + 1];
    // A following known flag (or any dash-prefixed token) means the value is
    // missing — addresses never start with '-', so this cannot eat a value.
    if (next === undefined || next.startsWith('-')) {
      throw new StandaloneCliArgsError(`Missing value for ${flag}.`);
    }
    return { value: next, consumedNext: true };
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (name === '--port' || name === '-p') {
      const { value, consumedNext } = readValue(name, inlineValue, i);
      options.port = normalizeStandalonePort(value);
      if (consumedNext) i++;
      continue;
    }
    if (name === '--host' || name === '-H') {
      const { value, consumedNext } = readValue(name, inlineValue, i);
      options.host = normalizeStandaloneHostAddress(value);
      hostExplicit = true;
      if (consumedNext) i++;
      continue;
    }
    if (name === '--token') {
      const { value, consumedNext } = readValue(name, inlineValue, i);
      if (!value.trim()) throw new StandaloneCliArgsError('Missing value for --token.');
      options.token = value;
      if (consumedNext) i++;
      continue;
    }
    if (name === '--public') {
      const { value, consumedNext } = readValue(name, inlineValue, i);
      if (!value.trim()) throw new StandaloneCliArgsError('Missing value for --public.');
      options.publicDir = value;
      if (consumedNext) i++;
      continue;
    }
    if (name === '--no-open') {
      options.open = false;
      continue;
    }
    if (name === '--dev') {
      options.dev = true;
      continue;
    }
    if (name === '--help' || name === '-h') {
      showHelp = true;
      continue;
    }
    if (token.startsWith('-') && !isKnownFlag(token)) {
      throw new StandaloneCliArgsError(`Unknown option "${token}". Run with --help to see usage.`);
    }
    // Positional tokens are ignored (runtime commands are dispatched before parsing).
  }

  return { options, hostExplicit, showHelp };
}
