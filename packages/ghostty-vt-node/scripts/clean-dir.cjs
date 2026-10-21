#!/usr/bin/env node
// Remove a directory tree completely, or fail. CMakeLists.txt uses this to
// empty the private zig caches before a release build. CMake's own
// file(REMOVE_RECURSE) and `cmake -E remove_directory` cannot delete names
// Win32 normalizes away, such as the macOS AppleDouble `._.` entries zig
// extracts from some packages: DeleteFileW without the \\?\ prefix strips the
// trailing dot, fails, and the removal stops part-way. Node's fs.rmSync uses
// \\?\ paths on Windows and deletes them.
//
// Exit 0 only when the directory is gone afterwards; anything else is a
// failure the caller must treat as fatal.
//
//   node scripts/clean-dir.cjs <absolute directory>
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target || !path.isAbsolute(target) || path.parse(target).root === path.resolve(target)) {
    console.error('usage: clean-dir.cjs <absolute directory, not a filesystem root>');
    process.exit(2);
}
try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch (error) {
    console.error(`clean-dir: could not remove ${target}: ${error.code ?? ''} ${error.message}`);
    process.exit(1);
}
if (fs.existsSync(target)) {
    console.error(`clean-dir: ${target} still exists after removal`);
    process.exit(1);
}
