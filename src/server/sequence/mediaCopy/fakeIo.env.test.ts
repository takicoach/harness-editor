import {afterEach,expect,it,vi} from 'vitest';
import {chmod,mkdir,mkdtemp,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nodeCopyIo} from './io';
import {fakeIoFromEnv} from './fakeIo';

const dirs:string[]=[],saved={...process.env};
afterEach(async()=>{vi.restoreAllMocks();vi.resetModules();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
  for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const settings=async(change:(dir:string,config:Record<string,unknown>)=>void=()=>undefined)=>{
  const dir=await mkdtemp(join(tmpdir(),'media-copy-fake-'));dirs.push(dir);const config=join(dir,'fake.json');
  const value:Record<string,unknown>={home:join(dir,'home'),volumes:[{mountPoint:join(dir,'sd'),uuid:'SD',kind:'external',fsType:'exfat',removable:true,capacity:64*2**30,free:10*2**30}],
    speeds:[{prefix:join(dir,'sd'),purpose:'probe',bytesPerSecond:2**20,virtual:true}]};
  change(dir,value);await writeFile(config,JSON.stringify(value),{mode:0o600});return {dir,config};
};
it('reads the audit fake only from a settings file inside the temporary folder',async()=>{
  const {dir,config}=await settings();
  expect(fakeIoFromEnv(nodeCopyIo,{})).toBeUndefined();
  const io=fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:config})!;expect((await io.mounts())[0]).toMatchObject({mountPoint:join(dir,'sd'),kind:'external'});
  expect(await io.volumeDetails(join(dir,'sd'))).toMatchObject({uuid:'SD',removable:true});   // 偽装のボリュームも取り外し可能かを持つ
  const before=io.now();await io.throttle('probe',join(dir,'sd','a.mp4'),2**20);expect(io.now()-before).toBeGreaterThanOrEqual(1000);
  expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:'/etc/hosts'})).toThrow('一時フォルダー');
});
it('refuses a settings file others can rewrite, one that is not a plain file, a fake world outside the temporary folder and the desktop app',async()=>{
  const {dir,config}=await settings();
  await chmod(config,0o666);expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:config})).toThrow('書き換えられない');
  await chmod(config,0o620);expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:config})).toThrow('書き換えられない');
  await chmod(config,0o644);expect(fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:config})).toBeDefined();
  const folder=join(dir,'folder.json');await mkdir(folder);expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:folder})).toThrow('書き換えられない');
  // 偽のボリューム・ホームが一時フォルダーの外を指す設定（コピーが実際のドライブ・ホームに書く）は断る
  for(const change of [(config:Record<string,unknown>)=>{config.home='/Users';},(config:Record<string,unknown>)=>{(config.volumes as Array<Record<string,unknown>>)[0]!.mountPoint='/Volumes/SD';}]){
    const outside=await settings((_,config)=>change(config));expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:outside.config})).toThrow('一時フォルダー');
  }
  // 一時フォルダーの中から外へのリンクも外として断る
  const linked=await settings((dir,config)=>{config.home=join(dir,'escape','home');});await symlink('/Users',join(linked.dir,'escape'));
  expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:linked.config})).toThrow('一時フォルダー');
  // デスクトップ版のサーバ（HARNESS_DESKTOP_CACHE がある）では、設定が正しくても使わない
  expect(()=>fakeIoFromEnv(nodeCopyIo,{HARNESS_TEST_MEDIA_COPY_FAKE:config,HARNESS_DESKTOP_CACHE:join(dir,'cache')})).toThrow('デスクトップ版');
  expect((await stat(config)).isFile()).toBe(true);
});
it('switches copyIo to the fake once, warns once, and slows the shared digest only while the checked fake is on',async()=>{
  const {config}=await settings(),warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  const file=join(dirs[0]!,'source.bin');await writeFile(file,Buffer.alloc(2*2**20+1,7));
  const {fileIdentity}=await import('../sharedDigest');const identity=fileIdentity(await stat(file));
  // 試験の実行の外（VITEST なし）で、偽装の設定が不正なら照合を遅くしない（警告もしない）
  delete process.env.VITEST;Object.assign(process.env,{HARNESS_TEST_DIGEST_DELAY_MS:'1000',HARNESS_TEST_MEDIA_COPY_FAKE:'/etc/hosts'});
  {const io=await import('./io'),digest=await import('../sharedDigest');expect(io.mediaCopyFakeActive()).toBe(false);expect(()=>io.copyIo()).toThrow('一時フォルダー');
    const started=performance.now();await digest.sharedFileDigest(file,identity);expect(performance.now()-started).toBeLessThan(1000);}
  expect(warn).not.toHaveBeenCalled();
  vi.resetModules();process.env.HARNESS_TEST_MEDIA_COPY_FAKE=config;
  {const io=await import('./io'),digest=await import('../sharedDigest');const fake=io.copyIo();expect(fake).not.toBe(io.nodeCopyIo);expect(io.copyIo()).toBe(fake);expect(io.mediaCopyFakeActive()).toBe(true);
    expect((await fake.mounts()).map(mount=>mount.kind)).toEqual(['external']);
    const started=performance.now();await digest.sharedFileDigest(file,identity);expect(performance.now()-started).toBeGreaterThanOrEqual(2000);}
  expect(warn).toHaveBeenCalledTimes(1);expect(String(warn.mock.calls[0]![0])).toContain('HARNESS_TEST_MEDIA_COPY_FAKE');
  // 設定が無ければ本物の外界（遅延も効かない）
  vi.resetModules();delete process.env.HARNESS_TEST_MEDIA_COPY_FAKE;
  {const io=await import('./io');expect(io.copyIo()).toBe(io.nodeCopyIo);expect(io.mediaCopyFakeActive()).toBe(false);}
},15000);
