import { describe, expect, it } from 'vitest';
import { workingDirBasename } from '../../src/providers/working-dir.js';

describe('workingDirBasename', () => {
  it('returns the basename of a win32 path (POSIX-only split would leak the full path)', () => {
    expect(workingDirBasename('D:\\gh\\adhdev-cloud')).toBe('adhdev-cloud');
  });

  it('returns the basename of a mac/POSIX path', () => {
    expect(workingDirBasename('/Users/x/proj')).toBe('proj');
  });

  it('handles trailing separators on either OS', () => {
    expect(workingDirBasename('C:\\a\\b\\')).toBe('b');
    expect(workingDirBasename('/a/b/')).toBe('b');
  });

  it('handles mixed separators', () => {
    expect(workingDirBasename('D:/gh\\adhdev-cloud')).toBe('adhdev-cloud');
    expect(workingDirBasename('C:\\a/b')).toBe('b');
  });

  it('falls back to "session" for empty / root-only / undefined input', () => {
    expect(workingDirBasename('')).toBe('session');
    expect(workingDirBasename('/')).toBe('session');
    expect(workingDirBasename('\\')).toBe('session');
    // @ts-expect-error — guard against undefined working dir at the boundary
    expect(workingDirBasename(undefined)).toBe('session');
  });
});
