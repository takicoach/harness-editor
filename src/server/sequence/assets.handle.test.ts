// src/server/sequence/assets.handle.test.ts
// パス指定のコピー: 確かめた後・読む前だけ別のファイルに差し替え、読み終えてから戻す経路を断る（開いたファイルの同一性を照合し、そのファイルから読む）。
import {afterEach,expect,it,vi} from 'vitest';
const swap=vi.hoisted(()=>({target:'',calls:0,before:null as null|(()=>Promise<void>),after:null as null|(()=>Promise<void>)}));
vi.mock('node:fs/promises',async load=>{const fs=await load<typeof import('node:fs/promises')>();return {...fs,stat:async(...args:Parameters<typeof fs.stat>)=>{
  if(swap.target&&String(args[0])===swap.target){
    swap.calls++;
    if(swap.calls===1){const info=await fs.stat(...args);await swap.before?.();return info;}   // 確かめた直後に差し替える
    if(swap.calls===2)await swap.after?.();                                                     // 読み終えた後に戻す
  }
  return fs.stat(...args);
}};});
import {mkdtemp,mkdir,readdir,rename,rm,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importSequenceAssetDetailed} from './assets';

const owned:string[]=[];
afterEach(async()=>{swap.target='';swap.calls=0;swap.before=null;swap.after=null;for(const dir of owned.splice(0))await rm(dir,{recursive:true,force:true});});
function wav(seed:number){const b=Buffer.alloc(44+1600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE((i*seed)%100,i);return b;}

it('refuses a copy whose source was swapped between the check and the read, even when it is swapped back before the final check',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'assets-handle-')));owned.push(root);
  // 途中のフォルダごと差し替える（ファイル自身の ctime などは変わらないので、パスを見るだけの確認では戻した後に気づけない）。
  const project=join(root,'project'),folder=join(root,'media'),source=join(folder,'a.wav');await mkdir(project);await mkdir(folder);await writeFile(source,wav(1));
  swap.target=source;
  swap.before=async()=>{await rename(folder,`${folder}.orig`);await mkdir(folder);await writeFile(source,wav(7));};
  swap.after=async()=>{await rm(folder,{recursive:true});await rename(`${folder}.orig`,folder);};
  await expect(importSequenceAssetDetailed(project,source,'a.wav')).rejects.toThrow(/元の素材が変更されました/);
  expect(swap.calls).toBeGreaterThanOrEqual(1);   // 差し替えの経路を本当に通った（存在の確認）
  expect((await readdir(join(project,'.harness','assets'))).filter(name=>name.endsWith('.json'))).toEqual([]);
});
it('copies an untouched source as before (control)',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'assets-handle-')));owned.push(root);
  const project=join(root,'project'),source=join(root,'a.wav');await mkdir(project);await writeFile(source,wav(1));
  await expect(importSequenceAssetDetailed(project,source,'a.wav')).resolves.toMatchObject({asset:{kind:'media',name:'a.wav'}});
});
