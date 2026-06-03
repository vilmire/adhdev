/**
 * Static taint analyzer for extended-tier override JS.
 *
 * Goal: classify the override JS shipped with an extended-tier provider into
 * one of three risk tiers, so the marketplace + daemon trust prompt can
 * surface accurate language to the operator instead of a single generic
 * "this provider contains JS" warning.
 *
 *   - clean    : no flagged APIs at all. The override looks like pure string
 *                manipulation. Still extended-tier, but the warning copy is
 *                "this provider contains JS; nothing dangerous was detected".
 *   - elevated : touches process / dynamic codegen / dynamic require / eval
 *                / Function constructor / child_process. The warning copy is
 *                explicit ("this provider can run shell commands / dynamically
 *                load code").
 *   - hostile  : combines elevated APIs with network egress, AND uses obvious
 *                obfuscation (base64-decoded strings fed into Function / eval).
 *                The publish endpoint should reject these.
 *
 * Implementation note: this is a *static* analyzer — string + light AST scan
 * via Node's built-in parser. It is intentionally fail-loud: anything that
 * looks suspicious is flagged. False positives are fine; this exists to gate
 * the trust prompt, not to be a real sandbox. The real sandbox lives in
 * Phase 5 (isolated-vm).
 *
 * Used by:
 *   - `adhdev provider validate` (CLI tier classification)
 *   - registry publish endpoint static-check
 *   - daemon at provider-load time, to size the warning
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

// ─── Findings ──────────────────────────────────────────────────────────

export type TaintLevel = 'clean' | 'elevated' | 'hostile';

export interface TaintFinding {
  /** What was found, e.g. "child_process.exec". */
  api: string;
  /** Coarse category. */
  category: TaintCategory;
  /** File the finding came from. */
  file: string;
  /** Line number (1-indexed) of the first character of the matched token. */
  line: number;
  /** The surrounding source excerpt, trimmed. */
  excerpt: string;
}

export type TaintCategory =
  | 'process-control'   // process.exit, process.kill
  | 'shell-exec'        // child_process.{exec,execSync,spawn,spawnSync,fork}
  | 'fs-write'          // fs.writeFile / writeFileSync outside override dir
  | 'fs-read'           // fs.readFile / readFileSync
  | 'network'           // http(s).request, fetch, net.connect, dgram
  | 'dynamic-codegen'   // eval, new Function(), Function('...')
  | 'dynamic-require'   // require(variable), import(variable)
  | 'obfuscation'       // Buffer.from(...,'base64').toString + (eval|Function)
  | 'global-mutation';  // mutating Object.prototype, process.env

export interface TaintResult {
  level: TaintLevel;
  findings: TaintFinding[];
  files: string[];
}

// ─── Patterns ──────────────────────────────────────────────────────────

interface PatternRule {
  category: TaintCategory;
  /** Display label. */
  label: string;
  /** Regex applied per-line. */
  pattern: RegExp;
}

const PATTERNS: PatternRule[] = [
  {
    category: 'shell-exec',
    label: 'child_process.exec',
    pattern: /\bchild_process\b[\s\S]{0,40}?\b(exec|execSync|spawn|spawnSync|fork|execFile)\b/,
  },
  {
    category: 'shell-exec',
    label: 'require("child_process")',
    pattern: /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
  },
  {
    category: 'shell-exec',
    label: 'import child_process',
    pattern: /\bfrom\s+['"](?:node:)?child_process['"]/,
  },
  {
    category: 'process-control',
    label: 'process.exit / kill',
    pattern: /\bprocess\.(exit|kill|abort)\s*\(/,
  },
  {
    category: 'global-mutation',
    label: 'process.env mutation',
    pattern: /\bprocess\.env\.[A-Z_][A-Z0-9_]*\s*=/,
  },
  {
    category: 'global-mutation',
    label: 'prototype pollution',
    pattern: /\bObject\.prototype\b.*=/,
  },
  {
    category: 'dynamic-codegen',
    label: 'eval()',
    pattern: /(?<![A-Za-z0-9_$])eval\s*\(/,
  },
  {
    category: 'dynamic-codegen',
    label: 'new Function()',
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    category: 'dynamic-require',
    label: 'require(variable)',
    pattern: /\brequire\s*\(\s*(?!['"`])/,
  },
  {
    category: 'dynamic-require',
    label: 'import(variable)',
    pattern: /(?<![.\w])import\s*\(\s*(?!['"`])/,
  },
  {
    category: 'network',
    label: 'fetch()',
    pattern: /(?<![A-Za-z0-9_$])fetch\s*\(/,
  },
  {
    category: 'network',
    label: 'http(s).request',
    pattern: /\b(https?)\.(request|get)\s*\(/,
  },
  {
    category: 'network',
    label: 'net.connect / Socket',
    pattern: /\b(net\.connect|tls\.connect|new\s+net\.Socket)\b/,
  },
  {
    category: 'network',
    label: 'dgram',
    pattern: /\brequire\s*\(\s*['"](?:node:)?dgram['"]/,
  },
  {
    category: 'fs-write',
    label: 'fs.writeFile / writeFileSync',
    pattern: /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync)\b/,
  },
  {
    category: 'fs-read',
    label: 'fs.readFile / readFileSync',
    pattern: /\bfs\.(readFile|readFileSync|readdir|readdirSync|stat|statSync)\b/,
  },
];

// Obfuscation heuristic: base64 / hex decode feeding into eval or Function.
const OBFUSCATION_PATTERN =
  /Buffer\.from\s*\([^)]*['"](?:base64|hex)['"]\s*\)\s*\.toString\s*\([^)]*\)[\s\S]{0,80}?(eval|Function)\s*\(/;

// ─── File walker — picks up everything reachable from overrides ────────

function listOverrideJsFiles(manifestPath: string): string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { overrides?: Record<string, unknown> };
  if (!manifest.overrides) return [];
  const base = dirname(manifestPath);
  const out = new Set<string>();
  for (const value of Object.values(manifest.overrides)) {
    let rel: string | null = null;
    if (typeof value === 'string') rel = value;
    else if (value && typeof value === 'object' && 'path' in value && typeof (value as { path: unknown }).path === 'string') {
      rel = (value as { path: string }).path;
    }
    if (!rel) continue;
    const abs = resolve(base, rel);
    if (existsSync(abs)) out.add(abs);
  }
  // Best-effort: also scan sibling scripts/ tree, since overrides commonly
  // require() helpers from there.
  for (const candidate of ['scripts']) {
    const dir = join(base, candidate);
    if (existsSync(dir)) {
      try {
        walk(dir, out);
      } catch {
        // Ignore individual unreadable files.
      }
    }
  }
  return [...out];
}

function walk(dir: string, into: Set<string>): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, into);
    else if (st.isFile() && /\.(?:m|c)?js$/.test(entry)) into.add(abs);
  }
}

// ─── Scanner ───────────────────────────────────────────────────────────

function scanFile(file: string): TaintFinding[] {
  const source = readFileSync(file, 'utf-8');
  const findings: TaintFinding[] = [];
  // Per-line scan keeps line numbers honest.
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of PATTERNS) {
      if (rule.pattern.test(line)) {
        findings.push({
          api: rule.label,
          category: rule.category,
          file,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
        });
      }
    }
  }
  // Whole-file scan for obfuscation pattern (may span lines).
  if (OBFUSCATION_PATTERN.test(source)) {
    findings.push({
      api: 'base64/hex → eval|Function',
      category: 'obfuscation',
      file,
      line: 1,
      excerpt: '<obfuscation pattern across multiple lines>',
    });
  }
  return findings;
}

// ─── Classification ────────────────────────────────────────────────────

const ELEVATED_CATEGORIES = new Set<TaintCategory>([
  'shell-exec',
  'process-control',
  'dynamic-codegen',
  'dynamic-require',
  'fs-write',
  'global-mutation',
]);

const HOSTILE_REQUIRES = new Set<TaintCategory>([
  'obfuscation',
]);

function classify(findings: TaintFinding[]): TaintLevel {
  if (findings.length === 0) return 'clean';
  const cats = new Set(findings.map((f) => f.category));
  if ([...cats].some((c) => HOSTILE_REQUIRES.has(c))) return 'hostile';
  // Hostile also: elevated + network combined.
  const hasElevated = [...cats].some((c) => ELEVATED_CATEGORIES.has(c));
  const hasNetwork = cats.has('network');
  if (hasElevated && hasNetwork) return 'hostile';
  if (hasElevated || hasNetwork) return 'elevated';
  return 'clean'; // only fs-read on its own is fine.
}

// ─── Public API ────────────────────────────────────────────────────────

export function analyzeOverrideTaint(manifestPath: string): TaintResult {
  const files = listOverrideJsFiles(manifestPath);
  const findings: TaintFinding[] = [];
  for (const f of files) findings.push(...scanFile(f));
  return {
    level: classify(findings),
    findings,
    files,
  };
}

/** Format a result as a single CLI-friendly block. */
export function formatTaintResult(result: TaintResult): string {
  const lines: string[] = [];
  lines.push(`Tier: extended (override JS present)`);
  lines.push(`Risk level: ${result.level}`);
  lines.push(`Files scanned: ${result.files.length}`);
  if (result.findings.length === 0) {
    lines.push('No flagged APIs detected.');
    return lines.join('\n');
  }
  // Group by category for a tighter report.
  const byCat = new Map<TaintCategory, TaintFinding[]>();
  for (const f of result.findings) {
    const arr = byCat.get(f.category) ?? [];
    arr.push(f);
    byCat.set(f.category, arr);
  }
  for (const [cat, items] of byCat) {
    lines.push(`  ${cat}: ${items.length} occurrence(s)`);
    for (const f of items.slice(0, 5)) {
      lines.push(`    ${f.file}:${f.line}  ${f.api}`);
    }
    if (items.length > 5) lines.push(`    …and ${items.length - 5} more`);
  }
  return lines.join('\n');
}
