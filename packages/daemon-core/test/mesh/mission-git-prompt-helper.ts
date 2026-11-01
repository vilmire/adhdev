import { buildMissionPromptSection } from '../../src/mesh/mesh-mission-prompt.js';

/** The coordinator-prompt block of one mission (the section holds every active mission; pick the one with `id`). */
export function buildMissionRenderBlockForTest(meshId: string, missionId: string): string {
    const section = buildMissionPromptSection(meshId).split('\nContinue each mission')[0];
    const blocks = section.split(/\n(?=- \*\*)/);
    return blocks.find(b => b.includes(`\`${missionId}\``)) ?? section;
}
