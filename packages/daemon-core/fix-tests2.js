const fs = require('fs');
let content = fs.readFileSync('test/cli-adapters/provider-cli-adapter-send-guard.test.ts', 'utf8');

const linesToChange = [66, 117, 147, 175, 194, 217, 260, 269, 294, 310, 340, 368, 627, 715];
let lines = content.split('\n');

for (const num of linesToChange) {
  if (lines[num - 1].includes('queued')) {
    lines[num - 1] = lines[num - 1].replace("'queued'", "'delivered'");
  }
}

fs.writeFileSync('test/cli-adapters/provider-cli-adapter-send-guard.test.ts', lines.join('\n'));
