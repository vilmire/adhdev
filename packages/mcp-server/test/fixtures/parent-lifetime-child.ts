// Child fixture for parent-lifetime.test.ts: an idle "stdio MCP server" that holds a
// ref'd handle (the IPC WebSocket pool stands in as an interval) and installs the
// real lifetime guard. Reports its active-resource census on stdout as JSON lines.
import { exitWhenParentGone } from '../../src/transports/parent-lifetime.js';

const census = () => process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap').sort();
const keepAlive = setInterval(() => {}, 60_000);
process.stdin.resume();
const before = census();
exitWhenParentGone({
  label: 'fixture',
  shutdown: async () => { clearInterval(keepAlive); process.stdout.write(JSON.stringify({ shutdown: true }) + '\n'); },
  watch: { pollMs: Number(process.env.FIXTURE_POLL_MS || 200) },
});
const after = census();
process.stdout.write(JSON.stringify({ pid: process.pid, before, after }) + '\n');
let polls = 0;
const sampler = setInterval(() => {
  polls += 1;
  process.stdout.write(JSON.stringify({ poll: polls, census: census() }) + '\n');
  if (polls >= 3) clearInterval(sampler);
}, 250);
