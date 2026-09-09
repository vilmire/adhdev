/**
 * plan_mesh_onboarding failures carry a machine-readable `code` (e.g.
 * `onboarding_blocked`) alongside a human `error`/`action` pair. The UI used
 * to render `${code || 'onboarding_blocked'}: ${error} ${action}` directly,
 * so a real failure surfaced with a raw snake_case prefix glued onto it
 * (e.g. "onboarding_blocked: not a git repository "). The code exists for
 * callers that branch on it, not for display — drop it here, the same way
 * the success branches next to this one never show a code either.
 */
export function describeOnboardingPlanFailure(plan: { error?: string; action?: string } | null | undefined): string {
    const error = plan?.error?.trim() || 'Git discovery failed'
    const action = plan?.action?.trim()
    return action ? `${error} ${action}` : error
}
