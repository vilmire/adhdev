/**
 * v1-contract provider scaffolding — the CLI and ACP builders shared by
 * `adhdev provider init` (packages/daemon-cloud/src/cli/provider-commands.ts,
 * offline-first) and the DevServer `/api/scaffold` route
 * (daemon/dev-server.ts, used by web-devconsole and as the online-first path
 * of `adhdev provider create`).
 *
 * Moved from daemon-cloud (2026-09-25) so both call sites share a single
 * source of truth instead of two independently-maintained copies — the
 * dev-server route previously emitted a legacy provider.json +
 * scripts/0.1/*.js layout for category=cli, which cannot launch: the legacy
 * CLI engine (ProviderCliAdapter + CliStateEngine) was deleted, and a CLI
 * provider with no resolvable FSM spec fails at launch
 * (providers/spec/route.ts formatNoResolvableSpecError).
 *
 * `ide`/`extension` categories are NOT covered here — they still use the
 * legacy provider.json + scripts/<version>/*.js template
 * (daemon/scaffold-template.ts) because that engine (CDP automation) is
 * still live; there is no generic scaffold that could produce a working
 * IDE/extension provider.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Docs pointer for the hand-authored provider guide. Also asserted by
 * `scripts/verify-docs.mjs`'s hardcoded-link check (packages/** scan) via
 * daemon-cloud's own remaining references to this same URL string — this
 * literal must resolve to a real docs/site page
 * (docs/site/guide/custom-providers.md).
 */
export const CUSTOM_PROVIDERS_DOCS_URL = 'https://docs.adhf.dev/guide/custom-providers';

/**
 * Only `cli` and `acp` have a scaffoldable out-of-tree layout today.
 * `cli` = provider.v1.json + specs/*.json (FSM engine, mandatory since the
 * legacy scripts/tui-manifest CLI engine was deleted — see
 * providers/spec/route.ts). `acp` = a single declarative provider.v1.json
 * (stdio Agent Client Protocol, no code). `ide`/`extension` require real CDP
 * automation scripts hand-written against a specific IDE's DOM/webview —
 * there is no generic template that would produce a working provider.
 */
export const INIT_SCAFFOLDABLE_CATEGORIES = new Set(['cli', 'acp']);

function defaultDisplayName(type: string): string {
    return type.split('-').map((s: string) => s[0]?.toUpperCase() + s.slice(1)).join(' ');
}

function defaultBinaryName(type: string, explicit?: string): string {
    return explicit || type.replace(/-(cli|acp)$/, '');
}

export interface CliProviderScaffoldOptions {
    type: string;
    name?: string;
    binary?: string;
}

export interface CliProviderScaffoldResult {
    manifest: Record<string, unknown>;
    spec: Record<string, unknown>;
    manifestPath: string;
    specPath: string;
    readme: string;
    binary: string;
    name: string;
}

/**
 * Build the current-shape CLI provider scaffold: provider.v1.json (schema
 * required fields: type, name, category, binary, spawn) + compatibility
 * pointing at specs/1.0.json, and the smallest FSM spec validateFsmSpec
 * accepts (id, binary, send_message.submit_key, states[] with exactly one
 * initial, transitions[]). Mirrors the reviewed working example in
 * docs/site/guide/custom-providers.md (python-repl / specs/1.0.json).
 */
export function buildCliProviderV1Scaffold(options: CliProviderScaffoldOptions): CliProviderScaffoldResult {
    const { type } = options;
    const name = options.name || defaultDisplayName(type);
    const binary = defaultBinaryName(type, options.binary);

    const manifest: Record<string, unknown> = {
        $schema: 'https://registry.adhf.dev/schemas/v1/cli/provider.schema.json',
        type,
        name,
        category: 'cli',
        binary,
        spawn: {
            command: binary,
            args: [],
            shell: false,
        },
        compatibility: [
            { ideVersion: '>=0.0.0', spec: 'specs/1.0.json' },
        ],
    };

    // Smallest spec validateFsmSpec accepts: an idle/busy pair driven off a
    // stand-in "ready" marker the author is expected to replace. Kept
    // intentionally trivial — a real spec needs the author's own knowledge
    // of the target binary's screen states; see custom-providers.md.
    const spec: Record<string, unknown> = {
        $schema: 'adhdev:cli/spec@4',
        id: type,
        name,
        binary,
        send_message: { submit_key: '\r' },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'busy', label: 'Working', status: 'generating' },
        ],
        transitions: [
            {
                label: 'startup → idle',
                from: 'starting',
                to: 'idle',
                when: { matches: 'READY_MARKER_REPLACE_ME' },
            },
            {
                label: 'idle → busy',
                from: 'idle',
                to: 'busy',
                min_hold_ms: 200,
                when: { not: { matches: 'READY_MARKER_REPLACE_ME' } },
            },
            {
                label: 'busy → idle',
                from: 'busy',
                to: 'idle',
                min_hold_ms: 300,
                when: {
                    all: [
                        { matches: 'READY_MARKER_REPLACE_ME' },
                        { stable_ms: 500 },
                    ],
                },
            },
        ],
    };

    const readme = `# ${name}\n\n`
        + `ADHDev CLI provider for \`${binary}\`.\n\n`
        + `Generated by \`adhdev provider init\` against the v1 contract (provider.v1.json + FSM spec).\n\n`
        + `**Before this runs for real**, replace every \`READY_MARKER_REPLACE_ME\` in `
        + `\`specs/1.0.json\` with a regex that actually matches ${binary}'s idle-prompt output — the `
        + `placeholder will never match, so the provider will report "generating" forever until you do.\n\n`
        + `## Validate\n\n\`\`\`bash\nadhdev provider validate ./\n\`\`\`\n\n`
        + `## Learn more\n\n${CUSTOM_PROVIDERS_DOCS_URL}\n`;

    return {
        manifest,
        spec,
        manifestPath: 'provider.v1.json',
        specPath: path.join('specs', '1.0.json'),
        readme,
        binary,
        name,
    };
}

/**
 * Resolve a CLI provider's FSM spec path the same way the daemon does at
 * load time (providers/provider-loader-spec-wiring.ts applySpecNativeHistoryWiring):
 * compatibility[].spec first (any entry whose ideVersion is unpinned or
 * matches, since callers like `adhdev provider validate` have no installed-CLI
 * version to compare against), then specs/default.json, then legacy
 * spec.json. Returns null when nothing on that chain exists on disk — mirrors
 * formatNoResolvableSpecError's own candidate list so validation catches the
 * exact failure providers/spec/route.ts would hit at launch, without
 * duplicating the FSM validation logic itself (that stays in validateFsmSpec).
 */
export function resolveCliSpecPath(manifestDir: string, manifest: { compatibility?: unknown }): string | null {
    const candidates: string[] = [];
    if (Array.isArray(manifest.compatibility)) {
        for (const entry of manifest.compatibility as Array<{ spec?: unknown }>) {
            if (typeof entry?.spec === 'string') candidates.push(path.join(manifestDir, entry.spec));
        }
    }
    candidates.push(path.join(manifestDir, 'specs', 'default.json'));
    candidates.push(path.join(manifestDir, 'spec.json'));
    return candidates.find((p) => fs.existsSync(p)) || null;
}

export interface AcpProviderScaffoldOptions {
    type: string;
    name?: string;
    binary?: string;
}

export interface AcpProviderScaffoldResult {
    manifest: Record<string, unknown>;
    manifestPath: string;
    readme: string;
    binary: string;
    name: string;
}

/**
 * Build the current-shape ACP provider scaffold. ACP providers are
 * declarative-only (schema: providers/sdk/v1/schemas/acp/provider.schema.json)
 * — a single provider.v1.json with `spawn.command`, no FSM spec, no
 * scripts.js. The daemon drives session state over the stdio Agent Client
 * Protocol instead of screen-scraping a PTY.
 */
export function buildAcpProviderV1Scaffold(options: AcpProviderScaffoldOptions): AcpProviderScaffoldResult {
    const { type } = options;
    const name = options.name || defaultDisplayName(type);
    const binary = defaultBinaryName(type, options.binary);

    const manifest: Record<string, unknown> = {
        $schema: 'https://registry.adhf.dev/schemas/v1/acp/provider.schema.json',
        type,
        name,
        category: 'acp',
        spawn: {
            command: binary,
            args: [],
            shell: false,
        },
    };

    const readme = `# ${name}\n\n`
        + `ADHDev ACP provider for \`${binary}\`.\n\n`
        + `Generated by \`adhdev provider init\` against the v1 ACP contract. ACP providers speak the `
        + `[Agent Client Protocol](https://agentclientprotocol.com) over stdio — no FSM spec or CDP `
        + `scripts required, but \`${binary}\` must actually implement the ACP protocol for this to work.\n\n`
        + `## Validate\n\n\`\`\`bash\nadhdev provider validate ./\n\`\`\`\n\n`
        + `## Learn more\n\n${CUSTOM_PROVIDERS_DOCS_URL}\n`;

    return { manifest, manifestPath: 'provider.v1.json', readme, binary, name };
}
