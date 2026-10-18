import type { DriverManifest } from './contracts.js';

export type DriverRiskClass = 'low' | 'elevated';

/** RFC rev3 §5.3. Derived from a validated manifest, never a manifest field. */
export function deriveDriverRiskClass(
  manifest: Pick<DriverManifest, 'actions' | 'declaredAccess'>,
): { riskClass: DriverRiskClass; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.declaredAccess?.desktopControl === true) {
    reasons.push('Desktop control is declared');
  }
  for (const action of manifest.actions) {
    if (action.risk === 'destructive') {
      reasons.push(`Destructive action: ${action.id}`);
    }
  }
  for (const scope of manifest.declaredAccess?.filesystem ?? []) {
    // workspace is the schema's symbolic scope. Every other declaration
    // needs approval; do not infer confinement from relative path spelling.
    if (scope !== 'workspace') reasons.push(`Filesystem access outside workspace: ${scope}`);
  }
  // Network access alone does not elevate risk.
  return { riskClass: reasons.length > 0 ? 'elevated' : 'low', reasons };
}
