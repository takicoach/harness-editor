import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const opened=vi.hoisted(()=>({count:0}));
vi.mock('node:fs/promises',async load=>{const fs=await load<typeof import('node:fs/promises')>();return {...fs,open:(...args:Parameters<typeof fs.open>)=>{opened.count++;return fs.open(...args);}};});
import {FileChangedError,fileIdentity,sharedFileDigest} from './sharedDigest';
const roots:string[]=[];afterEach(async()=>{opened.count=0;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function file(){const root=await mkdtemp(join(tmpdir(),'harness-digest-'));roots.push(root);const path=join(root,'source.bin'),bytes=Buffer.alloc(3*1024*1024+7,9);await writeFile(path,bytes);
  return {path,identity:fileIdentity(await stat(path)),expected:createHash('sha256').update(bytes).digest('hex')};}
it('hashes one file once for every concurrent caller with the same identity',async()=>{
  const f=await file(),digests=await Promise.all([1,2,3].map(()=>sharedFileDigest(f.path,f.identity)));
  expect(digests).toEqual([f.expected,f.expected,f.expected]);expect(opened.count).toBe(1);
});
it('keeps hashing for the callers still waiting when the first caller is cancelled',async()=>{
  const f=await file(),first=new AbortController();
  const a=sharedFileDigest(f.path,f.identity,first.signal),b=sharedFileDigest(f.path,f.identity);
  first.abort(new Error('要求が取り消されました'));
  await expect(a).rejects.toThrow('要求が取り消されました');expect(await b).toBe(f.expected);expect(opened.count).toBe(1);
});
it('refuses a file whose identity is not the one the caller checked, and remembers nothing on disk',async()=>{
  const f=await file();await writeFile(f.path,Buffer.alloc(10,1));
  await expect(sharedFileDigest(f.path,f.identity)).rejects.toBeInstanceOf(FileChangedError);
  const fresh=fileIdentity(await stat(f.path));await sharedFileDigest(f.path,fresh);await sharedFileDigest(f.path,fresh);expect(opened.count).toBe(3);
});
it('tells a waiting caller how many bytes each read actually returned (the short last read too)',async()=>{
  const f=await file(),seen:number[]=[];
  expect(await sharedFileDigest(f.path,f.identity,undefined,bytes=>seen.push(bytes))).toBe(f.expected);
  expect(seen).toEqual([1024*1024,1024*1024,1024*1024,7]);
});
