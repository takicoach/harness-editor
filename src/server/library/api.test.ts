import {createServer,type Server} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {sampleCatalog} from './__fixtures__/catalog';

let lib:string,root:string,server:Server,origin:string;
beforeEach(async()=>{
  lib=await realpath(await mkdtemp(join(tmpdir(),'harness-library-api-')));root=await mkdtemp(join(tmpdir(),'harness-root-'));
  vi.stubEnv('HARNESS_LIBRARY_DIR',lib);
  await mkdir(join(lib,'効果音'));await writeFile(join(lib,'効果音/pop.wav'),Buffer.from('RIFF0123456789'));
  await writeFile(join(lib,'catalog.json'),JSON.stringify(sampleCatalog()));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(e=>sendApiError(res,e));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterEach(async()=>{vi.unstubAllEnvs();await new Promise(r=>server.close(r));await rm(lib,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});

const fileUrl=(key:string,part='media')=>`${origin}/api/library/file?key=${encodeURIComponent(key)}&part=${part}`;
it('lists the library with missing items',async()=>{
  const body=await (await fetch(`${origin}/api/library`)).json();
  expect(body.ok).toBe(true);expect(body.catalog.media[0].name).toBe('ポン');expect(body.missing).toContain('tpl:sample.motion:38');
});
it('serves media by key with ranges and never by raw path',async()=>{
  const key=sampleCatalog().media[0]!.key;
  const full=await fetch(fileUrl(key));
  expect(full.status).toBe(200);expect(full.headers.get('accept-ranges')).toBe('bytes');expect(full.headers.get('content-type')).toContain('audio');
  const part=await fetch(fileUrl(key),{headers:{Range:'bytes=0-3'}});
  expect(part.status).toBe(206);expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('RIFF');
  expect(part.headers.get('content-range')).toBe('bytes 0-3/14');
  const suffix=await fetch(fileUrl(key),{headers:{Range:'bytes=-4'}});
  expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('6789');
  const open=await fetch(fileUrl(key),{headers:{Range:'bytes=10-'}});
  expect(Buffer.from(await open.arrayBuffer()).toString()).toBe('6789');
  expect((await fetch(fileUrl(key),{headers:{Range:'bytes=99-120'}})).status).toBe(416);
  expect((await fetch(`${origin}/api/library/file?path=../etc/passwd`)).status).toBe(400);
  expect((await fetch(fileUrl('se:nope'))).status).toBe(404);
  expect((await fetch(fileUrl(key,'bad'))).status).toBe(400);
  expect((await fetch(fileUrl('tpl:sample.motion:38','media'))).status).toBe(400);
  expect((await fetch(fileUrl('tpl:sample.motion:38','preview'))).status).toBe(404);
});
it('既定の場所に素材置場がまだ無ければ、空の一覧を返す（フォルダは作らない）',async()=>{
  vi.stubEnv('HARNESS_LIBRARY_DIR','');vi.stubEnv('HARNESS_PROJECT_ROOT',root);
  const body=await (await fetch(`${origin}/api/library`)).json();
  expect(body).toMatchObject({ok:true,directory:join(root,'素材置場'),catalog:{version:2,packs:[],templates:[],media:[]},missing:[]});
  await expect(realpath(join(root,'素材置場'))).rejects.toThrow();
});
it('rejects non-GET',async()=>{
  expect((await fetch(`${origin}/api/library`,{method:'POST'})).status).toBe(405);
});
it('returns 200 with a reason when the library is missing',async()=>{
  vi.stubEnv('HARNESS_LIBRARY_DIR',join(lib,'nothing'));
  const body=await (await fetch(`${origin}/api/library`)).json();expect(body.ok).toBe(false);expect(body.directory).toContain('nothing');
});

const FP2='b'.repeat(64);
const writeCatalog=(media:unknown[])=>writeFile(join(lib,'catalog.json'),JSON.stringify({...sampleCatalog(),media}));
const mediaItem=(key:string,kind:string,file:string,extra:object={})=>({key,kind,name:'x',desc:'',file,fingerprint:FP2,...extra});

it('reports catalog items whose file is gone as missing and 404s the file',async()=>{
  await writeCatalog([mediaItem('se:gone','se','効果音/gone.wav')]);
  const body=await (await fetch(`${origin}/api/library`)).json();
  expect(body.missing).toContain('se:gone');
  expect((await fetch(fileUrl('se:gone'))).status).toBe(404);
});
it('refuses symlinked items inside the library',async()=>{
  await symlink(join(lib,'効果音/pop.wav'),join(lib,'効果音/link.wav'));
  await writeCatalog([mediaItem('se:link','se','効果音/link.wav')]);
  expect((await fetch(fileUrl('se:link'))).status).toBe(400);
});
it('does not hijack /api/library-x',async()=>{
  const res=await fetch(`${origin}/api/library-x`);
  expect(res.headers.get('content-type')??'').not.toContain('audio');
  const text=await res.text();expect(text).not.toContain('"catalog"');
});
it('part=preview is a preview image: audio has none (404), image without preview falls back to the body',async()=>{
  const key=sampleCatalog().media[0]!.key;
  expect((await fetch(fileUrl(key,'preview'))).status).toBe(404);
  await mkdir(join(lib,'画像'));await writeFile(join(lib,'画像/a.png'),Buffer.from('PNGDATA'));
  await writeCatalog([mediaItem('img:a','image','画像/a.png')]);
  const res=await fetch(fileUrl('img:a','preview'));
  expect(res.status).toBe(200);expect(res.headers.get('content-type')).toBe('image/png');expect(await res.text()).toBe('PNGDATA');
});
it('serves correct content types and nosniff for every allowed extension',async()=>{
  const types:Record<string,string>={wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',ogg:'audio/ogg'};
  const media:unknown[]=[];
  for(const [ext] of Object.entries(types)){await writeFile(join(lib,`効果音/t.${ext}`),'x');media.push(mediaItem(`se:${ext}`,'se',`効果音/t.${ext}`));}
  await mkdir(join(lib,'画像'));
  const imgs:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
  for(const [ext] of Object.entries(imgs)){await writeFile(join(lib,`画像/t.${ext}`),'x');media.push(mediaItem(`img:${ext}`,'image',`画像/t.${ext}`));}
  await writeCatalog(media);
  for(const [ext,t] of Object.entries(types)){const r=await fetch(fileUrl(`se:${ext}`));expect(r.headers.get('content-type')).toBe(t);expect(r.headers.get('x-content-type-options')).toBe('nosniff');}
  for(const [ext,t] of Object.entries(imgs)){const r=await fetch(fileUrl(`img:${ext}`));expect(r.headers.get('content-type')).toBe(t);expect(r.headers.get('x-content-type-options')).toBe('nosniff');}
});
it('reports a broken catalog.json with a reason',async()=>{
  await writeFile(join(lib,'catalog.json'),'{broken');
  const body=await (await fetch(`${origin}/api/library`)).json();
  expect(body.ok).toBe(false);expect(body.reason).toContain('catalog.json');
});
it('survives a client disconnecting mid-stream',async()=>{
  await writeFile(join(lib,'効果音/big.wav'),Buffer.alloc(64*1024*1024,1));
  await writeCatalog([mediaItem('se:big','se','効果音/big.wav')]);
  const rejections:unknown[]=[];const onRej=(e:unknown)=>{rejections.push(e);};process.on('unhandledRejection',onRej);
  await new Promise<void>((resolve,reject)=>{
    const req=request(fileUrl('se:big'),res=>{res.once('data',()=>{req.destroy();res.destroy();setTimeout(resolve,300);});});
    req.on('error',()=>{});req.end();setTimeout(()=>reject(new Error('no data')),5000);
  });
  process.off('unhandledRejection',onRej);
  expect(rejections).toEqual([]);
  const next=await fetch(`${origin}/api/library`);expect(next.status).toBe(200);
});
