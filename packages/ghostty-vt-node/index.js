const path = require('node:path');

function loadBinding() {
    const candidates = [
        path.join(__dirname, 'build', 'Release', 'ghostty_vt_node.node'),
        path.join(__dirname, 'build', 'Debug', 'ghostty_vt_node.node'),
    ];

    const errors = [];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            errors.push(`${candidate}: ${error && error.message ? error.message : String(error)}`);
        }
    }

    throw new Error(
        `Unable to load @adhdev/ghostty-vt-node native binding. Build it with "npm run build -w packages/ghostty-vt-node". ${errors.join(' | ')}`,
    );
}

module.exports = loadBinding();
