import { describe, expect, expectTypeOf, it } from 'vitest';
import { isLaunchDefaultRole, isLaunchDefaultSource, LAUNCH_DEFAULT_ERROR_CODES,
    LAUNCH_DEFAULTS_NEXT_LAUNCH_NOTE, type LaunchDefaultResolution, type LaunchDefaultsApplied,
    type LaunchDefaultsError, type LaunchDefaultsProposal, type LaunchDefaultsReadRequest,
    type LaunchDefaultsSetRequest, type LaunchDefaultsStaged } from '../src/launch-defaults.js';

describe('launch defaults wire vocabulary', () => {
    it.each(['assistant', 'coordinator'])('recognizes explicit role %s', role => {
        expect(isLaunchDefaultRole(role)).toBe(true);
    });
    it.each(['worker', '', null, undefined, {}, 1])('refuses non-role %j', role => {
        expect(isLaunchDefaultRole(role)).toBe(false);
    });
    it.each(['user', 'stored_default', 'project_default', 'provider_default'])('recognizes provenance %s', source => {
        expect(isLaunchDefaultSource(source)).toBe(true);
    });
    it.each(['remembered', 'mesh_slot', 'legacy_registry', 'legacy_node_priority', 'builtin_default', 'browser', null])(
        'never claims fallback provenance %j', source => { expect(isLaunchDefaultSource(source)).toBe(false); });
    it('publishes explicit setup, validation, CAS and uncertain persistence failures', () => {
        expect(LAUNCH_DEFAULT_ERROR_CODES).toEqual(expect.arrayContaining([
            'launch_default_required', 'launch_default_unavailable', 'launch_selection_invalid',
            'launch_default_invalid', 'revision_conflict', 'persistence_failed', 'review_turn_tool_denied',
        ]));
        expect(LAUNCH_DEFAULTS_NEXT_LAUNCH_NOTE).toBe('Applies to the next launch; running sessions are unchanged.');
    });
});

describe('typed command guarantees (also checked with tsc)', () => {
    it('requires a CAS token for set and clear, and excludes foreign axes/authority', () => {
        const set: LaunchDefaultsSetRequest = { action: 'set', role: 'assistant', provider: 'claude-cli', expectedRevision: 0 };
        const clear: LaunchDefaultsSetRequest = { action: 'clear', role: 'coordinator', project: 'host-project', expectedRevision: 3 };
        expectTypeOf(set.expectedRevision).toEqualTypeOf<number>();
        expectTypeOf(clear.expectedRevision).toEqualTypeOf<number>();
        // @ts-expect-error CAS is mandatory for explicit first setup too.
        const missingCas: LaunchDefaultsSetRequest = { action: 'set', role: 'assistant', provider: 'claude-cli' };
        // @ts-expect-error Assistant defaults cannot be scoped to a project.
        const projectAssistant: LaunchDefaultsSetRequest = { ...set, project: 'repo' };
        // @ts-expect-error Clear does not carry a residual provider/model triple.
        const residual: LaunchDefaultsSetRequest = { ...clear, provider: 'codex-cli' };
        // @ts-expect-error Origin is trusted daemon context, never caller authority.
        const spoofedOrigin: LaunchDefaultsSetRequest = { ...set, origin: 'owner' };
        // @ts-expect-error Approval policy is excluded from the launch triple.
        const approval: LaunchDefaultsSetRequest = { ...set, autoApprove: true };
        void [missingCas, projectAssistant, residual, spoofedOrigin, approval];
    });
    it('requires a role and provider for validation, but permits an unfiltered read', () => {
        const get: LaunchDefaultsReadRequest = {};
        const check: LaunchDefaultsReadRequest = { action: 'check', role: 'coordinator', provider: 'codex-cli', model: 'gpt' };
        expectTypeOf(get).toMatchTypeOf<LaunchDefaultsReadRequest>();
        expectTypeOf(check).toMatchTypeOf<LaunchDefaultsReadRequest>();
        // @ts-expect-error A check is a complete provider-specific triple.
        const partial: LaunchDefaultsReadRequest = { action: 'check', role: 'assistant', model: 'opus' };
        // @ts-expect-error Project reads must explicitly target the coordinator role.
        const implicitProject: LaunchDefaultsReadRequest = { project: 'host-project' };
        void [partial, implicitProject];
    });
    it('distinguishes staged intent, durable application and uncertain replacement', () => {
        expectTypeOf<LaunchDefaultsApplied['durable']>().toEqualTypeOf<true>();
        expectTypeOf<LaunchDefaultsStaged['result']>().toEqualTypeOf<'staged'>();
        expectTypeOf<LaunchDefaultsStaged['expectedRevision']>().toEqualTypeOf<number>();
        const uncertain: LaunchDefaultsError = { success: false, code: 'persistence_failed',
            error: 'Directory fsync failed', reason: 'durability_unconfirmed', committed: true, documentRevision: 4 };
        expect(uncertain.success).toBe(false);
        expectTypeOf<Extract<'durable', keyof LaunchDefaultsStaged>>().toEqualTypeOf<never>();
    });
    it('carries the core resolver provenance and scope without prescribing another resolver', () => {
        type Applied = Extract<LaunchDefaultResolution, { ok: true }>;
        expectTypeOf<Applied['documentRevision']>().toEqualTypeOf<number>();
        expectTypeOf<Applied['applied']['provider']['source']>().toEqualTypeOf<'user' | 'stored_default' | 'project_default' | 'provider_default'>();
        expectTypeOf<LaunchDefaultsProposal['previous']>().toBeNullable();
        expectTypeOf<LaunchDefaultsProposal['selection']>().toBeNullable();
        expectTypeOf<Extract<LaunchDefaultResolution, { ok: false }>['code']>()
            .toEqualTypeOf<'launch_default_required' | 'launch_default_unavailable' | 'launch_selection_invalid'>();
    });
});
