// Test-only fake binding module used by ghostty-vt-backend-load-retry.test.ts to
// simulate a native-load failure/success without touching the real addon.
// Behavior is controlled by an env var so the test can flip it between calls
// (the caller is responsible for busting require.cache between phases since
// require() otherwise memoizes this module's export forever).
const mode = process.env.ADHDEV_GHOSTTY_VT_TEST_FIXTURE_MODE;

if (mode === 'module_not_found') {
    const err = new Error(`Cannot find module '${__filename}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
}

if (mode === 'transient_failure') {
    const err = new Error('bad_binding: incompatible ABI');
    err.code = 'ERR_DLOPEN_FAILED';
    throw err;
}

module.exports = {
    createTerminal() {
        return {
            write() {},
            resize() {},
            formatPlainText() {
                return '';
            },
            getCursorPosition() {
                return { col: 0, row: 0 };
            },
            dispose() {},
        };
    },
};
