import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { hiddenExecFileSync } from '../../src/process/hidden-spawn.js';
import { NodePtyTransportFactory } from '../../src/cli-adapters/pty-transport.js';

it.skipIf(process.env.ADHDEV_CLI_PRIORITY_LOAD !== '1' || process.platform === 'win32')(
  'LOAD: shell -> agent fixture -> Node/Go helpers inherit niceness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-cli-nice-'));
    const pids: number[] = [];
    try {
      const goSource = path.join(dir, 'helper.go');
      const goHelper = path.join(dir, 'go-helper');
      fs.writeFileSync(goSource, 'package main\nimport "time"\nfunc main(){time.Sleep(time.Minute)}\n');
      hiddenExecFileSync('go', ['build', '-o', goHelper, goSource], { timeout: 60_000 });
      const spawnModule = pathToFileURL(path.resolve('src/process/hidden-spawn.ts')).href;
      const agent = path.join(dir, 'agy-fixture.mjs');
      fs.writeFileSync(agent, `
import spawnHelpers from ${JSON.stringify(spawnModule)};
const {hiddenSpawn}=spawnHelpers;
const node=hiddenSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const go=hiddenSpawn(${JSON.stringify(goHelper)},[],{stdio:'ignore'});
console.log('TREE:'+JSON.stringify([process.pid,node.pid,go.pid]));
setInterval(()=>{},1000);`);
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      env.ADHDEV_CLI_CHILD_NICE = '10';
      const parentNice = os.getPriority(process.pid);
      const child = new NodePtyTransportFactory().spawn('/bin/sh', [
        '-c', '"$@" & wait', 'cli-priority-shell', process.execPath, '--import', 'tsx', agent,
      ], { cwd: process.cwd(), env, cols: 200, rows: 24 });
      pids.push(child.pid);
      const descendants = await new Promise<number[]>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`No fixture tree: ${output}`)), 20_000);
        child.onData((data) => {
          output += data;
          const match = output.match(/TREE:(\[[\d,]+\])/);
          if (match) {
            clearTimeout(timer);
            // Save exact PIDs before resolving so cleanup also owns descendants.
            const values = JSON.parse(match[1]) as number[];
            pids.push(...values);
            resolve(values);
          }
        });
      });
      process.stdout.write(hiddenExecFileSync('ps', ['-o', 'pid,ppid,ni,command', '-p', [process.pid, ...pids].join(',')], { encoding: 'utf8' }));
      for (const pid of [child.pid, ...descendants]) expect(os.getPriority(pid)).toBe(Math.min(19, parentNice + 10));
      expect(os.getPriority(process.pid)).toBe(parentNice);
    } finally {
      for (const pid of pids.reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000,
);
