import { describe, expect, it } from 'vitest';
import { parseRoleLaunchSelection } from '../src/role-launch';
import { parseSessionLaunchRecord } from '../src/session-launch';
const ref = { role: 'coordinator', scope: 'project', projectId: 'm', revision: 3 };
const role = { role: 'coordinator', documentRevision: 2, defaultRef: ref,
    selection: { provider: 'cli', model: 'm' }, applied: {
        provider: { value: 'cli', source: 'project_default', defaultRef: ref },
        model: { value: 'm', source: 'user' }, thinkingLevel: { value: null, source: 'provider_default' } } };
describe('persisted role launch provenance', () => {
    it('preserves a project token independent of the global document token', () => {
        expect(parseRoleLaunchSelection(role)).toEqual(role);
        const record = { sessionId: 's', providerType: 'cli', launchedAt: 1, launchedBy: 'mesh', roleLaunch: role,
            model: { source: 'project_default', history: [] }, thinkingLevel: { source: 'provider_default', history: [] } };
        expect(parseSessionLaunchRecord(record)).toEqual(record);
    });
    it.each([null, {}, { ...role, documentRevision: 0 }, { ...role, selection: { provider: 'other' } },
        { ...role, applied: { ...role.applied, provider: { value: 'cli', source: 'stored_default', defaultRef: ref } } },
        { ...role, role: 'assistant' }, { ...role, applied: { ...role.applied, model: { value: 'm', source: 'user', defaultRef: ref } } },
    ])('rejects incomplete, inconsistent or falsely attributed intent %#', value => {
        expect(parseRoleLaunchSelection(value)).toBeUndefined();
    });
});
