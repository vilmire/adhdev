// Removes temp dirs this test file created via mkdtemp* (mesh mission 8679dacb).
import { afterAll } from 'vitest';
import { removeTrackedTempDirs } from '../../../scripts/test-tmp-guard.mjs';

afterAll(() => removeTrackedTempDirs());
