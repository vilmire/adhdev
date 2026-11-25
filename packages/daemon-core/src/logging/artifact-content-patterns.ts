/** Internal shared artifact policy; moved byte-for-byte from artifact-path-guard. */
export const ARTIFACT_SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\b(?:adk|adm|shr|wtk|wtt|wsb)_[A-Za-z0-9_-]{12,}\b/,
    /\bmcp_sess_[A-Za-z0-9_-]{8,}\b/,
    /\bADHDEV_MCP_SESSION_CREDENTIAL\b/,
    /\bmcpSessionCredential(?:\s*(?<![=!<>])[:=](?![=>])|["']\s*:(?![=>]))\s*(?:(["'])(?!\[REDACTED|\$\{)(?:[^\s"'`\\]{6,}|[^\s"'`\\]*\u2026[^\s"'`\\]*)\1|(?![\"'])(?!\[REDACTED)(?:mcp_sess_|[A-Za-z0-9_~+/-]*[0-9][A-Za-z0-9_~+/-]*)[A-Za-z0-9_~+/-]{5,}={0,2}(?=$|[\s,;}\]&'"]))/i,
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:[A-Z0-9_]*?(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|SESSION_CREDENTIAL))(?:\s*(?<![=!<>])[:=](?![=>])|["']\s*:(?![=>]))\s*(?:(["'])(?!\[REDACTED|\$\{)(?:[^\s"'`\\]{8,}|[^\s"'`\\]*\u2026[^\s"'`\\]*)\1|(?![\"'])(?!\[REDACTED)(?:mcp_sess_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|eyJ|(?:adk|adm|adp|shr|wtk|wtt|wsb)_|[A-Za-z0-9_~+/-]*[0-9][A-Za-z0-9_~+/-]*)[A-Za-z0-9_~+/-]{8,}={0,2}(?=$|[\s,;}\]&'"]))/i,
];
