const fs = require('fs');
let content = fs.readFileSync('src/cli-adapters/session-host-transport.ts', 'utf8');
content = content.replace("const signal = typeof event.signal === 'number' ? event.signal : null;", "const signal = typeof (event as any).signal === 'number' ? (event as any).signal : null;");
fs.writeFileSync('src/cli-adapters/session-host-transport.ts', content);
