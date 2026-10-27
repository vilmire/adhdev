// Intermediate "agent CLI" for parent-lifetime.test.ts: spawns the MCP child with a
// stdin pipe it holds open, prints the child's pid, then idles until SIGKILLed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./parent-lifetime-child.ts', import.meta.url))], {
  stdio: ['pipe', 'ignore', 'ignore'],
  windowsHide: true,
  env: { ...process.env, FIXTURE_POLL_MS: '200' },
});
process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\n');
setInterval(() => {}, 60_000);
