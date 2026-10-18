import { describe, expect, it } from 'vitest';
import { deriveDriverRiskClass } from '../../src/drivers/risk-class.js';

describe('deriveDriverRiskClass', () => {
  it('elevates desktop control alone', () => {
    expect(deriveDriverRiskClass({ actions: [], declaredAccess: { desktopControl: true } }))
      .toEqual({ riskClass: 'elevated', reasons: ['Desktop control is declared'] });
  });

  it('elevates a destructive action alone', () => {
    expect(deriveDriverRiskClass({ actions: [{ id: 'wipe', tool: 'wipe', risk: 'destructive' }] }))
      .toEqual({ riskClass: 'elevated', reasons: ['Destructive action: wipe'] });
  });

  it.each(['/tmp', '../secrets', 'workspace/../secrets', '*', 'workspace/subdir'])(
    'elevates a filesystem scope other than workspace: %s', (scope) => {
      expect(deriveDriverRiskClass({ actions: [], declaredAccess: { filesystem: [scope] } }))
        .toEqual({ riskClass: 'elevated', reasons: [`Filesystem access outside workspace: ${scope}`] });
    },
  );

  it('keeps network alone low', () => {
    expect(deriveDriverRiskClass({ actions: [], declaredAccess: { network: ['*'] } }))
      .toEqual({ riskClass: 'low', reasons: [] });
  });

  it('keeps workspace, read/write actions and no desktop control low', () => {
    expect(deriveDriverRiskClass({
      actions: [{ id: 'navigate', tool: 'navigate', risk: 'write' }, { id: 'snapshot', tool: 'snapshot', risk: 'read' }],
      declaredAccess: { network: ['*'], filesystem: ['workspace'], desktopControl: false },
    })).toEqual({ riskClass: 'low', reasons: [] });
  });

  it('accumulates all reasons deterministically without changing the manifest', () => {
    const manifest = {
      actions: [{ id: 'wipe', tool: 'wipe', risk: 'destructive' as const }],
      declaredAccess: { desktopControl: true, filesystem: ['workspace', '/home'] },
    };
    const before = structuredClone(manifest);
    const result = deriveDriverRiskClass(manifest);
    expect(result).toEqual({ riskClass: 'elevated', reasons: [
      'Desktop control is declared', 'Destructive action: wipe', 'Filesystem access outside workspace: /home',
    ] });
    expect(deriveDriverRiskClass(manifest)).toEqual(result);
    expect(manifest).toEqual(before);
  });
});
