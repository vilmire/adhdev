import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getMeshConfigPath, withRecoveryMeshOwnershipFence, inRecoveryMeshOwnershipFence,
    withMeshConfigWriteLock, saveMeshConfig } from '../../src/config/mesh-config-store.js';

const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
function waitFile(path: string) {
    const deadline = Date.now() + 12000;
    while (!existsSync(path)) { if (Date.now() > deadline) throw new Error(`barrier timed out: ${path}`); pause(); }
    return readFileSync(path, 'utf8');
}
let prior: string | undefined;
beforeEach(() => { prior = process.env.ADHDEV_CONFIG_DIR; process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'owner-mutex-')); });
afterEach(() => { process.env.ADHDEV_CONFIG_DIR = prior; });
function script(body: string) {
    return `import store from ${JSON.stringify(pathToFileURL(resolve('src/config/mesh-config-store.ts')).href)};
        import fs from 'node:fs';
        const root = process.env.ADHDEV_CONFIG_DIR;
        const mark = (n,s='yes') => fs.writeFileSync(root+'/'+n,s);
        const wait = n => { const end=Date.now()+15000; while(!fs.existsSync(root+'/'+n)) {
            if(Date.now()>end) throw Error('child barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } };
        ${body}`;
}
function child(body: string) {
    return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script(body)],
        { env: { ...process.env }, windowsHide: true, stdio: 'pipe' });
}
describe('actual cross-process recovery owner fence', () => {
    it('excludes publication when a second process observed marker absence BEFORE recovery locked', () => {
        const root = process.env.ADHDEV_CONFIG_DIR!;
        const w = child(`mark('observed', String(fs.existsSync(store.getMeshConfigPath()+'.lock/operator-recovery-owner')));
            wait('publish'); try { store.saveMeshConfig({meshes:[]}); mark('result','PUBLISHED'); }
            catch(e) { mark('result',e.code); }`);
        try {
            expect(waitFile(join(root, 'observed'))).toBe('false');
            withRecoveryMeshOwnershipFence(() => {
                expect(inRecoveryMeshOwnershipFence()).toBe(true);
                writeFileSync(join(root, 'publish'), 'go');
                expect(waitFile(join(root, 'result'))).toBe('store_busy');
                expect(existsSync(getMeshConfigPath())).toBe(false);
            });
        } finally { w.kill(); }
    });
    it('never admits a timed-out ordinary callback, even if no recovery marker exists', () => {
        const root = process.env.ADHDEV_CONFIG_DIR!;
        mkdirSync(getMeshConfigPath()+'.lock'); // retained old-protocol holder H
        const w = child(`try { store.withMeshConfigWriteLock(() => { mark('admission','UNLOCKED'); wait('resume');
                store.saveMeshConfig({meshes:[]}); mark('result','PUBLISHED'); }); }
            catch(e) { mark('admission', e.code); mark('result',e.code); }`);
        try {
            const admission = waitFile(join(root, 'admission'));
            rmSync(getMeshConfigPath()+'.lock', {recursive:true}); // H releases, only in fixture
            withRecoveryMeshOwnershipFence(() => {
                writeFileSync(join(root, 'resume'), 'go');
                expect(waitFile(join(root, 'result'))).not.toBe('PUBLISHED');
            });
            expect(admission).toBe('store_busy');
        } finally { w.kill(); }
    });
    it('serializes a real ordinary holder through publication and releases on process exit without stale deletion', async () => {
        const root = process.env.ADHDEV_CONFIG_DIR!;
        const w = child(`store.withMeshConfigWriteLock(() => { mark('holding'); wait('publish');
            store.saveMeshConfig({meshes:[]}); process.exit(0); });`);
        const exited = new Promise(resolve => w.once('exit', resolve));
        try {
            waitFile(join(root, 'holding'));
            const path = getMeshConfigPath()+'.write-lock.sqlite';
            const inode = statSync(path).ino;
            utimesSync(path,new Date(0),new Date(0)); // stale mtime never authorizes theft
            expect(() => withRecoveryMeshOwnershipFence(() => { throw Error('ADMITTED'); })).toThrow('held');
            writeFileSync(join(root, 'publish'), 'go');
            // A metadata-only touch is not a replacement: ctime is deliberately not part
            // of the lock identity, so on Linux the holder publishes. On APFS an mtime
            // earlier than the birthtime also rewinds the birthtime, so the holder sees
            // a changed identity and refuses. Either way nothing half-written lands and
            // closing the process releases the real kernel lock.
            await exited;
            if (existsSync(getMeshConfigPath())) {
                expect(JSON.parse(readFileSync(getMeshConfigPath(), 'utf8'))).toEqual({ meshes: [] });
            } else {
                expect(process.platform).toBe('darwin');
            }
            withRecoveryMeshOwnershipFence(() => expect(statSync(path).ino).toBe(inode));
        } finally { w.kill(); }
    });
    it('a process exiting inside its held transaction releases the kernel lock without deleting its inode', async () => {
        const root = process.env.ADHDEV_CONFIG_DIR!;
        const w = child(`store.withMeshConfigWriteLock(() => { mark('holding'); wait('exit'); process.exit(0); });`);
        const exited = new Promise(resolve => w.once('exit', resolve));
        try {
            waitFile(join(root, 'holding'));
            const path = getMeshConfigPath()+'.write-lock.sqlite'; const inode = statSync(path).ino;
            expect(() => withRecoveryMeshOwnershipFence(() => {})).toThrow('held');
            writeFileSync(join(root, 'exit'), 'go'); await exited;
            withRecoveryMeshOwnershipFence(() => expect(statSync(path).ino).toBe(inode));
            withMeshConfigWriteLock(() => saveMeshConfig({meshes:[]}));
            expect(JSON.parse(readFileSync(getMeshConfigPath(),'utf8'))).toEqual({meshes:[]});
        } finally { w.kill(); }
    });
    it('an old process releasing a replaced lock incarnation cannot delete its replacement', async () => {
        const root = process.env.ADHDEV_CONFIG_DIR!;
        const w = child(`try { store.withMeshConfigWriteLock(() => { mark('holding'); wait('release'); }); mark('result','OK'); }
            catch(e) { mark('result',e.code); }`);
        const exited = new Promise(resolve => w.once('exit',resolve));
        try {
            waitFile(join(root,'holding'));
            const path = getMeshConfigPath()+'.write-lock.sqlite';
            renameSync(path,path+'.old'); writeFileSync(path,'replacement');
            writeFileSync(join(root,'release'),'go');
            expect(waitFile(join(root,'result'))).toBe('project_storage_unavailable');
            await exited;
            expect(readFileSync(path,'utf8')).toBe('replacement');
            expect(existsSync(path+'.old')).toBe(true);
        } finally { w.kill(); }
    });
    it('keeps a persistent inode, refuses stale legacy locks, and never deletes a replacement on release', () => {
        withMeshConfigWriteLock(() => saveMeshConfig({ meshes: [] }));
        const path = getMeshConfigPath()+'.write-lock.sqlite';
        expect(existsSync(path)).toBe(true);
        const inode = statSync(path).ino;
        withRecoveryMeshOwnershipFence(() => expect(statSync(path).ino).toBe(inode));
        expect(statSync(path).ino).toBe(inode);
        mkdirSync(getMeshConfigPath()+'.lock');
        utimesSync(getMeshConfigPath()+'.lock', new Date(0), new Date(0));
        expect(() => withMeshConfigWriteLock(() => { throw Error('CALLBACK'); })).toThrow('held');
        expect(existsSync(getMeshConfigPath()+'.lock')).toBe(true);
        rmSync(getMeshConfigPath()+'.lock', {recursive:true});
        expect(() => withRecoveryMeshOwnershipFence(() => {
            renameSync(path, path+'.old'); writeFileSync(path, 'replacement');
            saveMeshConfig({ meshes: [] });
        })).toThrow();
        expect(readFileSync(path,'utf8')).toBe('replacement');
        expect(() => withMeshConfigWriteLock(() => saveMeshConfig({ meshes: [] }))).toThrow();
    });
    it.each(['unlink','ABA','symlink','hardlink'])('refuses mutex inode %s without publishing', kind => {
        withMeshConfigWriteLock(() => {});
        const path = getMeshConfigPath()+'.write-lock.sqlite';
        expect(() => withRecoveryMeshOwnershipFence(() => {
            if (kind === 'unlink') rmSync(path);
            else if (kind === 'ABA') { renameSync(path,path+'.old'); writeFileSync(path,'other'); rmSync(path); renameSync(path+'.old',path); }
            else execFileSync(process.execPath, ['-e', kind === 'symlink'
                ? 'const f=require("fs");f.renameSync(process.argv[1],process.argv[1]+".old");f.symlinkSync(process.argv[1]+".old",process.argv[1])'
                : 'require("fs").linkSync(process.argv[1],process.argv[1]+".alias")', path], {windowsHide:true});
            saveMeshConfig({ meshes: [] });
        })).toThrow();
        expect(existsSync(getMeshConfigPath())).toBe(false);
    });
});
