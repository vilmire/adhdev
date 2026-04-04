const path = require('node:path');

function getTriplet() {
    return `${process.platform}-${process.arch}-node${process.versions.modules}`;
}

function loadBinding() {
    const triplet = getTriplet();
    const explicitPrebuiltDir = process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR
        ? path.resolve(process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR)
        : null;
    const candidates = [
        explicitPrebuiltDir ? path.join(explicitPrebuiltDir, triplet, 'ghostty_vt_node.node') : null,
        explicitPrebuiltDir ? path.join(explicitPrebuiltDir, 'ghostty_vt_node.node') : null,
        path.join(__dirname, 'build', 'Release', 'ghostty_vt_node.node'),
        path.join(__dirname, 'build', 'Debug', 'ghostty_vt_node.node'),
        path.join(__dirname, 'prebuilt', triplet, 'ghostty_vt_node.node'),
    ].filter(Boolean);

    const errors = [];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            errors.push(`${candidate}: ${error && error.message ? error.message : String(error)}`);
        }
    }

    throw new Error(
        `Unable to load @adhdev/ghostty-vt-node native binding for ${triplet}. Provide a prebuilt via ADHDEV_GHOSTTY_VT_PREBUILT_DIR or build it with "npm run build -w packages/ghostty-vt-node". ${errors.join(' | ')}`,
    );
}

module.exports = loadBinding();
