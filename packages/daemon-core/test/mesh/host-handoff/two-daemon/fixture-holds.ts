import { evaluateNewWorkHold } from '../../../../src/maintenance/new-work-hold.js';
export const readRecentHolds = () => evaluateNewWorkHold({ meshId: process.env.FIXTURE_MESH_ID! }).held;
