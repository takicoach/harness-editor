// ファイルを開く・読む処理の見張り（2026-10-06: 起動後に読み取りが open() で固まり、どのパスかが記録に無かった）。
// 書き手の無い FIFO は O_RDONLY の open が戻らない。試験の終わりに書き手を開いて止まった open を解放する（解放しないとプロセスが終了時に止まる）。
import {afterEach,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {FS_REPORT_MS,UnresponsiveFileError,fileLocationLabel,fsWatchTesting,watchedFs} from './fsWatch';

const roots:string[]=[],fifos:string[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();fsWatchTesting.reportMs=FS_REPORT_MS;
  for(const fifo of fifos.splice(0))await release(fifo);
  await vi.waitFor(()=>expect(fsWatchTesting.pending()).toEqual([]));
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
async function fifo(){const root=await mkdtemp(join(tmpdir(),'harness-fs-watch-'));roots.push(root);const path=join(root,'clip.mp4');execFileSync('/usr/bin/mkfifo',[path]);fifos.push(path);return path;}
/** 止まった読み手がいれば書き手を開いて解放する（読み手がいなければ ENXIO で何もしない）。 */
async function release(fifo:string){try{const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENXIO')throw e;}}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

it('logs the path and the wait once when opening does not return, and once more when it finally returns',async()=>{
  const path=await fifo(),warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);fsWatchTesting.reportMs=50;
  const opening=watchedFs('open',path,()=>open(path,'r'));
  await sleep(250);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toMatch(/^\[sme\] /);expect(warn.mock.calls[0]!.join(' ')).toContain(path);expect(warn.mock.calls[0]!.join(' ')).toMatch(/秒/);
  expect(fsWatchTesting.pending()).toMatchObject([{operation:'open',path}]);
  const writer=await open(fifos.pop()!,'w');const handle=await opening;await handle.close();await writer.close();
  expect(warn).toHaveBeenCalledTimes(2);expect(warn.mock.calls[1]!.join(' ')).toContain(path);expect(warn.mock.calls[1]!.join(' ')).toContain('戻りました');
});
it('does not log a call that returns in time',async()=>{
  const root=await mkdtemp(join(tmpdir(),'harness-fs-watch-'));roots.push(root);const path=join(root,'ok.txt');await writeFile(path,'x');
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);fsWatchTesting.reportMs=50;
  const handle=await watchedFs('open',path,()=>open(path,'r'));await handle.close();await sleep(100);
  expect(warn).not.toHaveBeenCalled();expect(fsWatchTesting.pending()).toEqual([]);
});
it('stops waiting at the limit, closes what opens late, and does not issue the same stuck call again',async()=>{
  const path=await fifo();vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  const disposed=vi.fn(async(handle:Awaited<ReturnType<typeof open>>)=>handle.close());
  const started=Date.now();
  await expect(watchedFs('open',path,()=>open(path,'r'),{limitMs:150,dispose:disposed})).rejects.toBeInstanceOf(UnresponsiveFileError);
  expect(Date.now()-started).toBeLessThan(1000);
  // 止まった open はまだ戻っていない。同じパスを開き直さずにすぐ断る（作業用スレッドを積み重ねて使い切らない）。
  const again=vi.fn(()=>open(path,'r'));
  await expect(watchedFs('open',path,again,{limitMs:150})).rejects.toMatchObject({code:'ETIMEDOUT',path,operation:'open'});
  expect(again).not.toHaveBeenCalled();expect(fsWatchTesting.pending()).toHaveLength(1);
  const writer=await open(fifos.pop()!,'w');
  await vi.waitFor(()=>expect(disposed).toHaveBeenCalledTimes(1));await writer.close();
  expect(fsWatchTesting.pending()).toEqual([]);
});
it('names the place without exposing the whole path',()=>{
  expect(fileLocationLabel('/Volumes/SDCARD/DCIM/100/clip.mp4')).toBe('ドライブ「SDCARD」');
  expect(fileLocationLabel(join(homedir(),'Desktop','clip.mp4'))).toBe('ホームの「Desktop」');
  expect(fileLocationLabel('/var/folders/x/clip.mp4')).toBe('このMacのディスク');
});
