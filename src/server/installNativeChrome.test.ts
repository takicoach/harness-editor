import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,rename,symlink,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {installNativeChrome,downloadNativeChrome,sha256File,type NativeChromeInstallDeps} from './installNativeChrome';
import {nativeChromeToolsPath,NATIVE_CHROME_VERSION} from './resolveNativeChromium';
import {NATIVE_CHROME_ARCHIVES} from './nativeChromeDistribution';
const options=(root:string)=>({editorRoot:root,platform:'darwin' as const,arch:'arm64'});
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-chrome-'))),bin=nativeChromeToolsPath(root,'darwin','arm64')!;
 const deps:NativeChromeInstallDeps={download:async(_,path)=>{await writeFile(path,'official-test-payload');},digest:async()=>NATIVE_CHROME_ARCHIVES['mac-arm64'],
  unpack:async(_,path)=>{const dest=join(path,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing');await mkdir(dirname(dest),{recursive:true});await writeFile(dest,'new-working-browser');},
  health:async(path)=>{if(await readFile(path,'utf8')!=='new-working-browser')throw new Error('bad-browser');},rename,lstat};
 return {root,bin,deps,done:()=>rm(root,{recursive:true,force:true})};
}
async function clean(root:string){expect((await readdir(join(root,'tools','chrome-for-testing'))).filter(x=>x.startsWith('.'))).toEqual([]);}
describe('full Chrome atomic installer',()=>{
 it('uses staged exact binary health then promotes, and reuses a healthy install without download',async()=>{const f=await fixture();try{
  const health=vi.fn(f.deps.health),download=vi.fn(f.deps.download);const first=await installNativeChrome(options(f.root),{...f.deps,health,download});expect(first).toEqual({bin:f.bin,installed:true});expect(health.mock.calls[1]![0]).toContain('.stage-');expect(await readFile(f.bin,'utf8')).toBe('new-working-browser');await clean(f.root);
  expect(await installNativeChrome(options(f.root),{...f.deps,download})).toEqual({bin:f.bin,installed:false});expect(download).toHaveBeenCalledTimes(1);
 }finally{await f.done();}});
 it.each(['download','digest','unpack','health','promotion'] as const)('keeps old installation and removes temporary state on %s failure',async(kind)=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const deps={...f.deps};
  if(kind==='download')deps.download=async()=>{throw Error('network-failed');};if(kind==='digest')deps.digest=async()=> '0'.repeat(64);if(kind==='unpack')deps.unpack=async()=>{throw Error('bad-zip');};if(kind==='health')deps.health=async()=>{throw Error('health-failed');};if(kind==='promotion')deps.rename=async(a,b)=>{if(String(a).endsWith('/unpacked'))throw Error('rename-failed');return rename(a,b);};
  await expect(installNativeChrome(options(f.root),deps)).rejects.toThrow();expect(await readFile(f.bin,'utf8')).toBe('old-browser');await clean(f.root);
 }finally{await f.done();}});
 it('stages an offline archive before verification/extraction and leaves the original untouched',async()=>{const f=await fixture();try{
  const source=join(f.root,'official.zip');await writeFile(source,'offline-original');
  const unpack=vi.fn(async(path:string,dir:string,platform:NodeJS.Platform)=>{expect(path).not.toBe(source);expect(await readFile(path,'utf8')).toBe('offline-original');await writeFile(source,'later-external-change');await f.deps.unpack(path,dir,platform);});
  await installNativeChrome({...options(f.root),archive:source},{...f.deps,unpack});expect(await readFile(source,'utf8')).toBe('later-external-change');await clean(f.root);
 }finally{await f.done();}});
 it('preserves recovery backup when promotion and rollback both fail',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const failing:NativeChromeInstallDeps['rename']=async(a,b)=>{if(String(a).endsWith('/unpacked')||String(a).endsWith('/previous'))throw Error('io-failure');return rename(a,b);};
  await expect(installNativeChrome(options(f.root),{...f.deps,rename:failing})).rejects.toThrow();const base=join(f.root,'tools','chrome-for-testing'),dirs=await readdir(base);expect(dirs).not.toContain('.install.lock');const stage=dirs.find(x=>x.startsWith('.stage-'))!;expect(stage).toBeTruthy();const saved=join(base,stage,'previous','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing');expect(await readFile(saved,'utf8')).toBe('old-browser');
 }finally{await f.done();}});
 it('cancels during preparation without retiring the old install or leaving the lock',async()=>{const f=await fixture();try{
  const controller=new AbortController();await expect(installNativeChrome({...options(f.root),signal:controller.signal},{...f.deps,download:async()=>{controller.abort();controller.signal.throwIfAborted();}})).rejects.toThrow();await clean(f.root);
 }finally{await f.done();}});
 it('rejects abort during real executable hashing before either rename',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const c=new AbortController(),moves=vi.fn(rename);
  const health=async(path:string)=>{if(path===f.bin)throw Error('old-unhealthy');await writeFile(path,Buffer.alloc(1024*1024,7));setImmediate(()=>c.abort(Error('cancel-before-retire')));};
  await expect(installNativeChrome({...options(f.root),signal:c.signal},{...f.deps,health,rename:moves})).rejects.toThrow('cancel-before-retire');
  expect(moves).not.toHaveBeenCalled();expect(await readFile(f.bin,'utf8')).toBe('old-browser');await clean(f.root);
 }finally{await f.done();}});
 it('checks cancellation after the final asynchronous target stat before retirement',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const c=new AbortController(),moves=vi.fn(rename);
  const stat=(async(path:Parameters<typeof lstat>[0])=>{const result=await lstat(path);c.abort(Error('cancel-after-stat'));return result;}) as typeof lstat;
  await expect(installNativeChrome({...options(f.root),signal:c.signal},{...f.deps,lstat:stat,rename:moves})).rejects.toThrow('cancel-after-stat');expect(moves).not.toHaveBeenCalled();expect(await readFile(f.bin,'utf8')).toBe('old-browser');await clean(f.root);
 }finally{await f.done();}});
 it.each([false,true])('rolls back a cancellation after retirement; preserves backup if rollback fails=%s',async(failRollback)=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const c=new AbortController(),moves:string[]=[];
  const move:NativeChromeInstallDeps['rename']=async(a,b)=>{moves.push(String(a));if(String(a).endsWith('/previous')&&failRollback)throw Error('rollback-failed');await rename(a,b);if(String(b).endsWith('/previous'))c.abort(Error('cancel-after-retire'));};
  await expect(installNativeChrome({...options(f.root),signal:c.signal},{...f.deps,rename:move})).rejects.toThrow(failRollback?'rollback-failed':'cancel-after-retire');
  expect(moves.some(x=>x.endsWith('/unpacked'))).toBe(false);
  if(failRollback){const base=join(f.root,'tools/chrome-for-testing'),dirs=await readdir(base);expect(dirs).not.toContain('.install.lock');const stage=dirs.find(x=>x.startsWith('.stage-'))!;expect(await readFile(join(base,stage,'previous','chrome-mac-arm64','Google Chrome for Testing.app','Contents/MacOS/Google Chrome for Testing'),'utf8')).toBe('old-browser');}
  else{expect(await readFile(f.bin,'utf8')).toBe('old-browser');await clean(f.root);}
 }finally{await f.done();}});
 it('keeps the original retirement error and old install when retirement itself fails',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const failure=Error('retirement-denied');const move=vi.fn(async()=>{throw failure;});
  await expect(installNativeChrome(options(f.root),{...f.deps,rename:move})).rejects.toBe(failure);expect(move).toHaveBeenCalledTimes(1);expect(await readFile(f.bin,'utf8')).toBe('old-browser');await clean(f.root);
 }finally{await f.done();}});
 it('retains cancellation as cause and both errors when restoring the old backup fails',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const c=new AbortController(),cancel=Error('cancel-retired'),rollback=Error('restore-denied');
  const move:NativeChromeInstallDeps['rename']=async(a,b)=>{if(String(a).endsWith('/previous'))throw rollback;await rename(a,b);if(String(b).endsWith('/previous'))c.abort(cancel);};
  const error=await installNativeChrome({...options(f.root),signal:c.signal},{...f.deps,rename:move}).then(()=>undefined,error=>error);
  expect(error).toBeInstanceOf(AggregateError);expect(error.cause).toBe(cancel);expect(error.errors).toEqual([cancel,rollback]);
  const base=join(f.root,'tools/chrome-for-testing'),dirs=await readdir(base),stage=dirs.find(x=>x.startsWith('.stage-'))!;expect(dirs).not.toContain('.install.lock');expect(await readFile(join(base,stage,'previous','chrome-mac-arm64','Google Chrome for Testing.app','Contents/MacOS/Google Chrome for Testing'),'utf8')).toBe('old-browser');
 }finally{await f.done();}});
 it('reports successful atomic promotion when abort arrives after commit begins',async()=>{const f=await fixture();try{
  await mkdir(dirname(f.bin),{recursive:true});await writeFile(f.bin,'old-browser');const c=new AbortController();
  const move:NativeChromeInstallDeps['rename']=async(a,b)=>{await rename(a,b);if(String(a).endsWith('/unpacked'))c.abort(Error('late-cancel'));};
  expect(await installNativeChrome({...options(f.root),signal:c.signal},{...f.deps,rename:move})).toEqual({bin:f.bin,installed:true});expect(c.signal.aborted).toBe(true);expect(await readFile(f.bin,'utf8')).toBe('new-working-browser');await clean(f.root);
 }finally{await f.done();}});
 it('rejects a concurrent installer and later releases its own lock',async()=>{const f=await fixture();try{
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);const first=installNativeChrome(options(f.root),{...f.deps,download:async(...args)=>{entered();await hold;await f.deps.download(...args);}});await ready;await expect(installNativeChrome(options(f.root),f.deps)).rejects.toThrow('install-busy');release();await first;await clean(f.root);
 }finally{await f.done();}});
 it('refuses tools symlink escape before any network request',async()=>{const f=await fixture(),outside=await mkdtemp(join(tmpdir(),'native-chrome-outside-'));try{
  await symlink(outside,join(f.root,'tools'));const download=vi.fn(f.deps.download);await expect(installNativeChrome(options(f.root),{...f.deps,download})).rejects.toThrow('unsafe-tools-directory');expect(download).not.toHaveBeenCalled();expect(await readdir(outside)).toEqual([]);
 }finally{await f.done();await rm(outside,{recursive:true,force:true});}});
 it('refuses an installed version symlink rather than health-checking an unrelated target',async()=>{const f=await fixture(),outside=await mkdtemp(join(tmpdir(),'native-chrome-outside-'));try{
  const base=join(f.root,'tools','chrome-for-testing');await mkdir(base,{recursive:true});await symlink(outside,join(base,NATIVE_CHROME_VERSION));await expect(installNativeChrome(options(f.root),f.deps)).rejects.toThrow('unsafe-installed-directory');await clean(f.root);
 }finally{await f.done();await rm(outside,{recursive:true,force:true});}});
});
describe('archive transport identity',()=>{
 it('hashes actual bytes against the literal known SHA256',async()=>{const root=await mkdtemp(join(tmpdir(),'native-sha-'));try{const file=join(root,'data');await writeFile(file,'abc');expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');}finally{await rm(root,{recursive:true,force:true});}});
 it.each(['http://example.com/a','https://example.com/a'])('rejects cleartext initial/redirect URL %s',async(url)=>{const mock=vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://example.com/b'}}));await expect(downloadNativeChrome(url,'unused',mock as typeof fetch)).rejects.toThrow('insecure-download-url');expect(mock.mock.calls.length).toBe(url.startsWith('http:')?0:1);});
 it('bounds redirects and never writes an unresolved redirect body',async()=>{const mock=vi.fn(async()=>new Response(null,{status:302,headers:{location:'/loop'}}));await expect(downloadNativeChrome('https://example.com/a','unused',mock as typeof fetch)).rejects.toThrow('download-failed');expect(mock).toHaveBeenCalledTimes(6);});
 it('downloads HTTPS bytes and respects caller abort',async()=>{const root=await mkdtemp(join(tmpdir(),'native-download-'));try{const file=join(root,'data');const mock=vi.fn(async()=>new Response('official bytes'));await downloadNativeChrome('https://example.com/a',file,mock as typeof fetch);expect(await readFile(file,'utf8')).toBe('official bytes');const abort=new AbortController();abort.abort();await expect(downloadNativeChrome('https://example.com/b',join(root,'other'),mock as typeof fetch,abort.signal)).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}});
});
