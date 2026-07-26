const fs = require('fs');
let content = fs.readFileSync('test/cli-adapters/outbound-queue-delivery-ack.test.ts', 'utf8');
content = content.replace("await vi.advanceTimersByTimeAsync(2000)", "await vi.advanceTimersByTimeAsync(2000)\n    await vi.advanceTimersByTimeAsync(10)");
fs.writeFileSync('test/cli-adapters/outbound-queue-delivery-ack.test.ts', content);
