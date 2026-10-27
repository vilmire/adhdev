/**
 * Expanded secret-exclusion list for project file transfer (owner decision D4).
 * Matches EXCLUDE ONLY: nothing here ever clears a file as safe, and there is no
 * override. A content sniff can add exclusions, never remove them.
 */

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
  '.password-store', '.terraform', '.adhdev', '.adhdev-transfer-staging',
]);

/** Two-segment directory pairs, e.g. `.config/gh`. */
const EXCLUDED_DIR_PAIRS = [['.config', 'gh'], ['.config', 'gcloud']] as const;

const EXCLUDED_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.envrc', '.git-credentials', '.pgpass', '.my.cnf',
  '.dockercfg', '.htpasswd', '.vault-token', '.boto', '.s3cfg', 'credentials', 'credentials.json',
  'kubeconfig', 'auth.json', 'tokens.json', 'token', 'secrets.json', 'secrets.yml', 'secrets.yaml',
  'wallet.dat', '.dev.vars', '.yarnrc.yml', '.env',
]);

const EXCLUDED_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'env-file', re: /^\.env\..+$/ },
  { rule: 'env-file', re: /^.+\.env$/ },
  { rule: 'dev-vars', re: /^\.dev\.vars\..+$/ },
  { rule: 'ssh-key', re: /^id_(rsa|dsa|ecdsa|ed25519)/ },
  { rule: 'key-material', re: /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc)$/ },
  { rule: 'terraform-state', re: /\.(tfstate|tfvars)(\..*)?$/ },
  { rule: 'cloud-credential', re: /^(client_secret|service-?account).*\.json$/ },
  { rule: 'secret-file', re: /(\.secrets?$|^secrets?\.)/ },
  { rule: 'kubeconfig', re: /\.kubeconfig$/ },
  { rule: 'mobileprovision', re: /\.mobileprovision$/ },
];

const PRIVATE_KEY_HEAD = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
export const SECRET_SNIFF_BYTES = 4096;

/** Name/path based exclusion. `relPath` is a `/`-separated project-relative path. Returns the rule or null. */
export function matchSecretPath(relPath: string): string | null {
  const segments = relPath.split('/').filter(Boolean).map((s) => s.toLowerCase());
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (EXCLUDED_DIRS.has(seg)) return `dir:${seg}`;
    for (const [a, b] of EXCLUDED_DIR_PAIRS) {
      if (seg === a && segments[i + 1] === b) return `dir:${a}/${b}`;
    }
  }
  const name = segments[segments.length - 1];
  if (!name) return null;
  if (EXCLUDED_NAMES.has(name)) return `name:${name}`;
  for (const p of EXCLUDED_PATTERNS) if (p.re.test(name)) return p.rule;
  return null;
}

/** Content sniff over the first bytes of a file; can only ADD an exclusion. */
export function sniffSecretContent(head: Uint8Array): string | null {
  const text = Buffer.from(head.subarray(0, SECRET_SNIFF_BYTES)).toString('latin1');
  return PRIVATE_KEY_HEAD.test(text) ? 'private-key-content' : null;
}
