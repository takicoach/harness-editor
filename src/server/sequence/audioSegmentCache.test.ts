import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile, mkdir, link, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AUDIO_SEGMENT_MAX_BYTES,openAudioSegmentCache,type AudioSegmentCache,type AudioSegmentCacheOptions} from './audioSegmentCache';

const faults=vi.hoisted(()=>({indexRename:undefined as undefined|(()=>Promise<void>), segmentRename:undefined as undefined|(()=>Promise<void>), segmentReads:undefined as undefined|{length:number;position:number}[], segmentStat:undefined as undefined|((path:string)=>Promise<void>),segmentUnlink:undefined as undefined|((path:string)=>Promise<void>)}));
vi.mock('node:fs/promises',async()=>{
  const real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {...real,lstat:async(...args:Parameters<typeof real.lstat>)=>{
    const value=await real.lstat(...args);if(String(args[0]).endsWith('.seg'))await faults.segmentStat?.(String(args[0]));return value;
  },unlink:async(...args:Parameters<typeof real.unlink>)=>{
    if(String(args[0]).endsWith('.seg'))await faults.segmentUnlink?.(String(args[0]));return real.unlink(...args);
  },open:async(...args:Parameters<typeof real.open>)=>{
    const f=await real.open(...args);
    if(String(args[0]).endsWith('.seg')){
      const read=f.read.bind(f);
      f.read=((...values:unknown[])=>{
        if(faults.segmentReads)faults.segmentReads.push({length:values[2] as number,position:values[3] as number});
        return Reflect.apply(read,f,values);
      }) as typeof f.read;
    }
    return f;
  },rename:async(a:string,b:string)=>{
    if(b.endsWith('.index'))await faults.indexRename?.();
    if(b.endsWith('.seg'))await faults.segmentRename?.();
    return real.rename(a,b);
  }};
});
const key=(label:string)=>createHash('sha256').update(label).digest('hex');
const roots:string[]=[], caches:AudioSegmentCache[]=[];
const free=async()=>10n**12n;
const dir=(root:string)=>join(root,'.harness','cache','audio-segments-v1');
async function setup(options:AudioSegmentCacheOptions={}) {
  const root=await mkdtemp(join(tmpdir(),'audio-segment-'));roots.push(root);
  const c=await openAudioSegmentCache(root,{headroomBytes:0,allocationUnitBytes:4096,availableBytes:free,...options});caches.push(c);return {root,c};
}
async function define(c:AudioSegmentCache,label='a',totalFrames=12) {
  const k=key(label);await c.defineStream({key:k,sampleRate:48000,channels:1,totalFrames});return k;
}
async function put(c:AudioSegmentCache,k:string,first:number,count=4,value=3) {
  const w=await c.beginWrite(k,first,count);await w.append(Buffer.alloc(count*4,value));await w.commit();
}
afterEach(async()=>{faults.indexRename=undefined;faults.segmentRename=undefined;faults.segmentReads=undefined;faults.segmentStat=undefined;faults.segmentUnlink=undefined;
  for(const c of caches.splice(0))await c.close().catch(()=>undefined);
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});

describe('project audio segment disk cache',()=>{
  it('only publishes committed, length/SHA verified PCM; read finally releases pin',async()=>{
    const {c}=await setup(),k=await define(c);const w=await c.beginWrite(k,0,4);
    await w.append(Buffer.alloc(8,7));expect(await c.acquire(k,0,4)).toBeNull();
    expect((await c.status(k)).reservedBytes).toBe(1024+16+4096);
    await w.append(Buffer.alloc(8,7));await w.commit();
    await expect(c.withSegment(k,0,4,async l=>{expect(await l.read()).toEqual(Buffer.alloc(16,7));throw new Error('consumer failure');})).rejects.toThrow('consumer failure');
    expect((await c.status(k)).pinnedSegments).toBe(0);expect((await c.status(k)).reservedBytes).toBe(0);
  });
  it('counts concurrent reservations across streams and never waits for pinned capacity',async()=>{
    const {c}=await setup({budgetBytes:8192+5140}),a=await define(c,'a'),b=await define(c,'b');
    const [one,two]=await Promise.allSettled([c.beginWrite(a,0,4),c.beginWrite(b,0,4)]);
    expect(one.status).toBe('fulfilled');expect(two.status).toBe('rejected');
    if(one.status==='fulfilled')await one.value.abort();expect((await c.status(a)).reservedBytes).toBe(0);
    const retry=await c.beginWrite(b,0,4);await retry.abort();
  });
  it('evicts old confirmed segments while producer is active; history survives eviction and regeneration',async()=>{
    const {root,c}=await setup({budgetBytes:9232}),k=await define(c);
    await put(c,k,0);await put(c,k,4);expect((await c.status(k)).resident).toEqual([{first:4,count:4}]);
    await put(c,k,8);await c.markComplete(k);
    expect(await c.status(k)).toMatchObject({producedThrough:12,complete:true,resident:[{first:8,count:4}]});
    await put(c,k,0);expect(await c.status(k)).toMatchObject({producedThrough:12,complete:true,resident:[{first:0,count:4}]});
    await c.close();const reopened=await openAudioSegmentCache(root,{budgetBytes:9232,headroomBytes:0,availableBytes:free});caches.push(reopened);
    expect(await reopened.status(k)).toMatchObject({producedThrough:12,complete:true,resident:[{first:0,count:4}]});
    expect(await reopened.acquire(k,4,4)).toBeNull();
    expect(await reopened.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,3));
  });
  it('read pins block eviction; last unpin determines LRU',async()=>{
    const {c}=await setup({budgetBytes:10272}),k=await define(c, 'a',16);
    await put(c,k,0);await put(c,k,4);
    const first=await c.acquire(k,0,4),second=await c.acquire(k,4,4);expect(first&&second).toBeTruthy();
    await expect(c.beginWrite(k,8,4)).rejects.toThrow('容量不足');
    await second!.release();await first!.release();await put(c,k,8);
    expect((await c.status(k)).resident).toEqual([{first:0,count:4},{first:8,count:4}]);
  });
  it('headroom includes unwritten reservations; checks again before physical writes',async()=>{
    let available=100000n;const {c}=await setup({headroomBytes:100,availableBytes:async()=>available}),k=await define(c);
    available=8291n;await expect(c.beginWrite(k,0,4)).rejects.toThrow('容量不足');
    available=8292n;const w=await c.beginWrite(k,0,4);available=99n;
    await expect(w.append(Buffer.alloc(16))).rejects.toThrow('容量不足');
    expect((await c.status(k)).reservedBytes).toBe(0);
  });
  it('reclaims unpinned data to recover real disk headroom, not only logical budget',async()=>{
    const {root,c}=await setup({headroomBytes:100,availableBytes:async p=>{
      const files=await readdir(p);return files.some(n=>n.endsWith('.seg'))?100n:100000n;
    }}),k=await define(c);await put(c,k,0);const w=await c.beginWrite(k,4,4);
    expect((await readdir(dir(root))).some(n=>n.endsWith('.seg'))).toBe(false);await w.abort();
  });
  it('cancels active writer and lease independently; no temp/reservation leak',async()=>{
    const {root,c}=await setup(),k=await define(c),abort=new AbortController();
    const w=await c.beginWrite(k,0,4,abort.signal);await w.append(Buffer.alloc(8));abort.abort();
    await expect(w.commit()).rejects.toThrow();expect((await c.status(k)).reservedBytes).toBe(0);
    expect((await readdir(dir(root))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
    await put(c,k,0);const controller=new AbortController(),l=await c.acquire(k,0,4,controller.signal);controller.abort();
    await expect(l!.read()).rejects.toThrow();await l!.release();expect((await c.status(k)).pinnedSegments).toBe(0);
  });
  it('rejects incomplete/oversized writes and keeps completion false',async()=>{
    const {c}=await setup(),k=await define(c);
    let w=await c.beginWrite(k,0,4);await w.append(Buffer.alloc(8));await expect(w.commit()).rejects.toThrow('不足');
    w=await c.beginWrite(k,0,4);await expect(w.append(Buffer.alloc(17))).rejects.toThrow('超過');
    await expect(c.markComplete(k)).rejects.toThrow('未完了');expect((await c.status(k)).producedThrough).toBe(0);
    const big=await define(c,'big',2**24);await expect(c.beginWrite(big,0,AUDIO_SEGMENT_MAX_BYTES/4)).rejects.toThrow('範囲');
  });
  it('supports exact maximum segment size and fails replay overlap/gap/format changes',async()=>{
    const {c}=await setup(),n=(AUDIO_SEGMENT_MAX_BYTES-1024)/4,k=await define(c,'max',n);
    await put(c,k,0,n);expect((await c.status(k)).usedBytes).toBe(4096+AUDIO_SEGMENT_MAX_BYTES);
    await expect(c.beginWrite(k,0,1)).rejects.toThrow('重複');
    const a=await define(c);await expect(c.beginWrite(a,4,4)).rejects.toThrow('範囲');
    await expect(c.defineStream({key:a,sampleRate:44100,channels:1,totalFrames:12})).rejects.toThrow('衝突');
  });
  it('a failed index replacement removes the new segment and preserves old history',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);
    const w=await c.beginWrite(k,4,4);await w.append(Buffer.alloc(16));faults.indexRename=async()=>{throw new Error('index disk failure');};
    await expect(w.commit()).rejects.toThrow('index disk failure');faults.indexRename=undefined;
    expect(await c.status(k)).toMatchObject({producedThrough:4,complete:false,reservedBytes:0,resident:[{first:0,count:4}]});
    expect((await readdir(dir(root))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
    await put(c,k,4);
  });
  it('abort before index commit cancels, while abort after atomic index rename belongs to committed result',async()=>{
    const {c}=await setup(),k=await define(c),a=new AbortController();let w=await c.beginWrite(k,0,4,a.signal);await w.append(Buffer.alloc(16));
    faults.segmentRename=async()=>{a.abort();};await expect(w.commit()).rejects.toThrow();faults.segmentRename=undefined;
    expect((await c.status(k)).producedThrough).toBe(0);
    // The mock is inside rename itself, after the last explicit cancellation check.
    const b=new AbortController();w=await c.beginWrite(k,0,4,b.signal);await w.append(Buffer.alloc(16));
    faults.indexRename=async()=>{b.abort();};await w.commit();faults.indexRename=undefined;
    expect(await c.status(k)).toMatchObject({producedThrough:4,resident:[{first:0,count:4}],reservedBytes:0});
  });
  it('shares canonical project manager and rejects conflicting settings/foreign locks',async()=>{
    const {root,c}=await setup();expect(await openAudioSegmentCache(root)).toBe(c);
    await expect(openAudioSegmentCache(root,{budgetBytes:1})).rejects.toThrow('異なり');
    await c.close();await mkdir(join(dir(root),'.lock'));await expect(openAudioSegmentCache(root)).rejects.toMatchObject({code:'EEXIST'});
  });
  it('retains read leases until explicit release and cancels writers on close',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const l=await c.acquire(k,0,4);
    await expect(c.close()).rejects.toThrow('lease');await l!.release();const w=await c.beginWrite(k,4,4);await w.append(Buffer.alloc(4));await c.close();
    expect((await readdir(dir(root))).filter(n=>n.endsWith('.tmp'))).toEqual([]);
    await expect(w.commit()).rejects.toThrow('閉じ');
  });
  it.each(['pcm','header','missing','index','hardlink','symlink'])('fails closed on %s corruption on live read or reopen',async mode=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);await c.close();const path=join(dir(root),`${k}-0-4.seg`);
    if(mode==='pcm'||mode==='header'){const bytes=await readFile(path);bytes[mode==='pcm'?1024:6]=bytes[mode==='pcm'?1024:6]!^1;await writeFile(path,bytes);}
    if(mode==='missing')await unlink(path);
    if(mode==='index'){const path2=join(dir(root),k+'.index'),b=await readFile(path2);b[10]=b[10]!^1;await writeFile(path2,b);}
    if(mode==='hardlink')await link(path,join(root,'linked'));
    if(mode==='symlink'){await unlink(path);await writeFile(join(root,'outside'),Buffer.alloc(1040));await symlink(join(root,'outside'),path);}
    if(mode==='missing'){const next=await openAudioSegmentCache(root);caches.push(next);expect(await next.acquire(k,0,4)).toBeNull();expect((await next.status(k)).producedThrough).toBe(4);}
    else await expect(openAudioSegmentCache(root)).rejects.toThrow();
  });
  it('rechecks SHA after acquiring and never converts corruption into silence',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const l=await c.acquire(k,0,4),path=join(dir(root),`${k}-0-4.seg`);
    const b=await readFile(path);b[1024]=0;await writeFile(path,b);await expect(l!.read()).rejects.toThrow('SHA');await l!.release();
  });
  it('rejects cache directory symlinks; does not touch external target',async()=>{
    const root=await mkdtemp(join(tmpdir(),'audio-segment-link-'));roots.push(root);const outside=await mkdtemp(join(tmpdir(),'audio-segment-outside-'));roots.push(outside);
    await symlink(outside,join(root,'.harness'));await expect(openAudioSegmentCache(root)).rejects.toThrow('directory');expect(await readdir(outside)).toEqual([]);
  });
  it('cleans owned orphan temp after explicit lock recovery, and represents empty completion',async()=>{
    const {root,c}=await setup(),k=await define(c,'empty',0);await c.markComplete(k);await c.close();
    await writeFile(join(dir(root),'pending-abcd-1234.tmp'),Buffer.alloc(100));
    const next=await openAudioSegmentCache(root);caches.push(next);expect(await next.status(k)).toMatchObject({complete:true,producedThrough:0,resident:[]});
    expect((await readdir(dir(root))).some(n=>n.endsWith('.tmp'))).toBe(false);
  });
  it('rejects a live corrupted progress index even while old in-memory status exists',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);
    const path=join(dir(root),k+'.index'),bytes=await readFile(path);bytes[10]=bytes[10]!^1;await writeFile(path,bytes);
    await expect(c.acquire(k,0,4)).rejects.toThrow();
    await expect(c.status(k)).rejects.toThrow();
  });

  it('zero-byte append cannot release an unwritten filesystem-block reservation',async()=>{
    let available=100000n;const {c}=await setup({headroomBytes:100,availableBytes:async()=>available}),k=await define(c);
    const w=await c.beginWrite(k,0,4);await w.append(Buffer.alloc(0));available=8291n;
    await expect(w.append(Buffer.alloc(16))).rejects.toThrow('容量不足');
    expect((await c.status(k)).reservedBytes).toBe(0);
  });

  it('accounts actual intermediate index plus both final files within the project budget',async()=>{
    const {root,c}=await setup({budgetBytes:9232}),k=await define(c);const w=await c.beginWrite(k,0,4);await w.append(Buffer.alloc(16));
    let observed=0;faults.indexRename=async()=>{
      const sizes=await Promise.all((await readdir(dir(root))).filter(n=>n!=='.lock').map(async n=>(await stat(join(dir(root),n))).size));
      observed=sizes.reduce((a,b)=>a+b,0);expect(observed).toBe(9232);
    };
    await w.commit();faults.indexRename=undefined;expect(observed).toBe(9232);expect((await c.status(k)).usedBytes).toBe(5136);
  });
  it('uses actual statfs and rejects a separate Node process while the project manager owns the lock',async()=>{
    const root=await mkdtemp(join(tmpdir(),'audio-cache-process-'));roots.push(root);
    const c=await openAudioSegmentCache(root,{headroomBytes:0});caches.push(c);const k=await define(c);await put(c,k,0);
    const url=pathToFileURL(resolve('src/server/sequence/audioSegmentCache.ts')).href;
    const child=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',
      `import {openAudioSegmentCache} from ${JSON.stringify(url)};try { await openAudioSegmentCache(${JSON.stringify(root)},{headroomBytes:0});process.exitCode=2;}catch(e){console.log(e.code);}`]);
    expect(child.stdout.trim()).toBe('EEXIST');expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,3));
  });

  it.each(['append','commit','index-replace'])('detects index corruption before %s without repairing it',async stage=>{
    const {root,c}=await setup(),k=await define(c),w=await c.beginWrite(k,0,4),path=join(dir(root),k+'.index');
    const original=await readFile(path),broken=Buffer.from(original);broken[20]=broken[20]!^1;
    if(stage!=='append')await w.append(Buffer.alloc(16,3));
    if(stage==='index-replace')faults.segmentRename=async()=>{await writeFile(path,broken);};else await writeFile(path,broken);
    await expect(stage==='append'?w.append(Buffer.alloc(16,3)):w.commit()).rejects.toThrow();
    expect(await readFile(path)).toEqual(broken);faults.segmentRename=undefined;
    expect((await readdir(dir(root))).filter(n=>n.endsWith('.tmp')||n.endsWith('.seg'))).toEqual([]);
    await writeFile(path,original);expect(await c.status(k)).toMatchObject({producedThrough:0,complete:false,reservedBytes:0});
  });
  it('admits one owned append before I/O, rejects concurrent copies, then accepts the next chunk',async()=>{
    let block=false,enteredResolve!:()=>void,continueResolve!:()=>void;
    const entered=new Promise<void>(r=>enteredResolve=r),continued=new Promise<void>(r=>continueResolve=r);
    const {c}=await setup({availableBytes:async()=>{if(block){enteredResolve();await continued;}return 10n**12n;}}),k=await define(c,'admission',8);
    const w=await c.beginWrite(k,0,8),payload=new Uint8Array(16).fill(7),original=Buffer.from;let owned=0;
    const spy=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{
      if(args[0]===payload)owned+=payload.byteLength;return Reflect.apply(original,Buffer,args);
    }) as typeof Buffer.from);
    try{
      block=true;const first=w.append(payload);await entered;
      const denied=Array.from({length:100},()=>w.append(payload));
      const pending=Promise.allSettled(denied);expect(owned).toBe(16);
      payload.fill(9);block=false;continueResolve();await first;
      expect((await pending).every(r=>r.status==='rejected')).toBe(true);
      await w.append(payload);expect(owned).toBe(32);await w.commit();
      expect(await c.withSegment(k,0,8,l=>l.read())).toEqual(Buffer.concat([Buffer.alloc(16,7),Buffer.alloc(16,9)]));
    }finally{block=false;continueResolve?.();spy.mockRestore();}
  });
  it('does not copy input after abort/commit admission or for over-reservation input',async()=>{
    const {c}=await setup(),k=await define(c),controller=new AbortController(),w=await c.beginWrite(k,0,4,controller.signal);
    const payload=new Uint8Array(16),oversized=new Uint8Array(17),original=Buffer.from;let owned=0;
    const spy=vi.spyOn(Buffer,'from').mockImplementation(((...args:unknown[])=>{
      if(args[0]===payload||args[0]===oversized)owned+=(args[0] as Uint8Array).byteLength;return Reflect.apply(original,Buffer,args);
    }) as typeof Buffer.from);
    try{
      controller.abort();await expect(w.append(payload)).rejects.toThrow();await w.abort();expect(owned).toBe(0);
      let next=await c.beginWrite(k,0,4);await expect(next.append(oversized)).rejects.toThrow('超過');expect(owned).toBe(0);
      next=await c.beginWrite(k,0,4);await next.append(payload);expect(owned).toBe(16);
      const committing=next.commit();await expect(next.append(payload)).rejects.toThrow();await committing;expect(owned).toBe(16);
      expect((await c.status(k)).reservedBytes).toBe(0);
    }finally{spy.mockRestore();}
  });

  it('evicts a corrupt unpinned victim without consuming it and can regenerate complete history',async()=>{
    const {root,c}=await setup({budgetBytes:9232}),k=await define(c,'bitrot',8);
    await put(c,k,0);const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);
    bytes[1024]=bytes[1024]!^1;await writeFile(path,bytes);
    await expect(c.acquire(k,0,4)).rejects.toThrow('SHA');
    faults.segmentReads=[];await put(c,k,4);
    expect(faults.segmentReads).toEqual([]);faults.segmentReads=undefined;
    await c.markComplete(k);expect(await c.status(k)).toMatchObject({complete:true,producedThrough:8,resident:[{first:4,count:4}]});
    expect(await c.acquire(k,0,4)).toBeNull();await put(c,k,0);
    expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,3));
    expect(await c.status(k)).toMatchObject({complete:true,producedThrough:8});await c.close();
  });
  it('status reads only bounded metadata per resident segment, but acquire and read still reject PCM bitrot',async()=>{
    const {root,c}=await setup(),count=65536,k=await define(c,'status-io',count*3);
    for(let n=0;n<3;n++)await put(c,k,n*count,count);
    faults.segmentReads=[];const result=await c.status(k),reads=faults.segmentReads;faults.segmentReads=undefined;
    expect(result.resident).toHaveLength(3);
    expect(reads.reduce((n,r)=>n+r.length,0)).toBeLessThanOrEqual(3*1024);
    expect(reads.every(r=>r.position+r.length<=1024)).toBe(true);
    const path=join(dir(root),`${k}-0-${count}.seg`),bytes=await readFile(path);bytes[1024]=bytes[1024]!^1;await writeFile(path,bytes);
    expect((await c.status(k)).resident).toHaveLength(3); // metadata availability is not a promise of PCM integrity
    await expect(c.acquire(k,0,count)).rejects.toThrow('SHA');
    const lease=await c.acquire(k,count,count);expect(lease).not.toBeNull();
    const second=join(dir(root),`${k}-${count}-${count}.seg`),broken=await readFile(second);broken[1024]=broken[1024]!^1;await writeFile(second,broken);
    await expect(lease!.read()).rejects.toThrow('SHA');await lease!.release();await c.close();
  });
  it('opens existing cache below headroom without eviction; pinned write fails and available read succeeds',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);await c.close();
    let probes=0;const next=await openAudioSegmentCache(root,{headroomBytes:1024**3,availableBytes:async()=>{probes++;return 0n;}});caches.push(next);
    expect(probes).toBe(0);expect((await next.status(k)).resident).toEqual([{first:0,count:4}]);
    const lease=await next.acquire(k,0,4);expect(lease).not.toBeNull();
    await expect(next.beginWrite(k,4,4)).rejects.toThrow('容量不足');expect(probes).toBeGreaterThan(0);
    expect(await lease!.read()).toEqual(Buffer.alloc(16,3));await lease!.release();await next.close();
  });
  it('opens empty cache below headroom but still rejects new metadata writes',async()=>{
    const {root,c}=await setup();await c.close();
    const next=await openAudioSegmentCache(root,{availableBytes:async()=>0n});caches.push(next);
    await expect(define(next)).rejects.toThrow('容量不足');await next.close();
    expect(await readdir(dir(root))).toEqual([]);
  });
  it('enforces logical budget on reopen independently of disk headroom',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);await put(c,k,4);await c.close();
    const next=await openAudioSegmentCache(root,{budgetBytes:4096+1040,availableBytes:async()=>0n});caches.push(next);
    const status=await next.status(k);expect(status.usedBytes).toBe(5136);expect(status.resident).toHaveLength(1);
    expect(status.producedThrough).toBe(8);await next.close();
    await expect(openAudioSegmentCache(root,{budgetBytes:4095,availableBytes:async()=>0n})).rejects.toThrow('容量不足');
    expect((await readdir(dir(root))).includes('.lock')).toBe(false);
  });

  it.each(['header','truncate','missing'])('status still rejects %s damage without consuming PCM',async damage=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);
    const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);
    if(damage==='missing')await unlink(path);
    else if(damage==='truncate')await writeFile(path,bytes.subarray(0,bytes.length-1));
    else {bytes[10]=bytes[10]!^1;await writeFile(path,bytes);}
    faults.segmentReads=[];await expect(c.status(k)).rejects.toThrow();
    expect(faults.segmentReads.every(r=>r.position+r.length<=1024)).toBe(true);
    faults.segmentReads=undefined;await c.close();
  });
  it.each(['symlink','hardlink','directory'])('status and eviction refuse a substituted %s and preserve the outside file',async kind=>{
    const {root,c}=await setup({budgetBytes:9232}),k=await define(c);await put(c,k,0);
    const path=join(dir(root),`${k}-0-4.seg`),outside=join(root,'outside'),bytes=await readFile(path);
    await writeFile(outside,bytes);await unlink(path);
    if(kind==='symlink')await symlink(outside,path);
    else if(kind==='hardlink')await link(outside,path);else await mkdir(path);
    await expect(c.status(k)).rejects.toThrow();
    await expect(c.beginWrite(k,4,4)).rejects.toThrow('退避対象');
    expect(await readFile(outside)).toEqual(bytes);expect((await readdir(dir(root))).some(n=>n.endsWith('.tmp'))).toBe(false);
    await c.close();
  });

  it('explicit discard recovers bitrot without budget pressure and preserves completed history',async()=>{
    const {root,c}=await setup(),k=await define(c,'discard-bitrot',4);await put(c,k,0);await c.markComplete(k);
    const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);bytes[1024]=bytes[1024]!^1;await writeFile(path,bytes);
    await expect(c.acquire(k,0,4)).rejects.toThrow('SHA');
    await expect(c.beginWrite(k,0,4)).rejects.toThrow('重複');
    await c.discardSegment(k,0,4);
    expect(await c.status(k)).toMatchObject({producedThrough:4,complete:true,resident:[],usedBytes:4096,reservedBytes:0});
    expect(await c.acquire(k,0,4)).toBeNull();await c.discardSegment(k,0,4);
    await put(c,k,0,4,9);expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,9));await c.close();
  });
  it.each(['header','truncation'] as const)('explicit discard recovers %s damage while preserving completed history',async damage=>{
    const {root,c}=await setup(),k=await define(c,`discard-${damage}`,4);await put(c,k,0);await c.markComplete(k);
    const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);
    if(damage==='header')bytes[0]=bytes[0]!^1;
    await writeFile(path,damage==='truncation'?bytes.subarray(0,16):bytes);
    await expect(c.status(k)).rejects.toThrow();await expect(c.acquire(k,0,4)).rejects.toThrow();
    await c.discardSegment(k,0,4);
    expect(await c.status(k)).toMatchObject({producedThrough:4,complete:true,resident:[],usedBytes:4096,reservedBytes:0});
    expect(await c.acquire(k,0,4)).toBeNull();
    await put(c,k,0,4,9);expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,9));await c.close();
  });
  it('capacity eviction forgets a known missing victim and lets the producer continue',async()=>{
    const {root,c}=await setup({budgetBytes:9232}),k=await define(c);await put(c,k,0);
    await unlink(join(dir(root),`${k}-0-4.seg`));
    await put(c,k,4);expect(await c.status(k)).toMatchObject({producedThrough:8,resident:[{first:4,count:4}],usedBytes:5136,reservedBytes:0});
    await c.close();
  });

  it('refuses discard while a corrupt segment is pinned, then recovers after release',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const lease=await c.acquire(k,0,4),path=join(dir(root),`${k}-0-4.seg`),b=await readFile(path);b[1024]=b[1024]!^1;await writeFile(path,b);
    await expect(c.discardSegment(k,0,4)).rejects.toThrow('lease');
    await expect(lease!.read()).rejects.toThrow('SHA');expect((await c.status(k)).pinnedSegments).toBe(1);
    await lease!.release();await c.discardSegment(k,0,4);expect((await c.status(k)).usedBytes).toBe(4096);await c.close();
  });
  it('discard preserves a running producer reservation and complete history across reopen',async()=>{
    const {root,c}=await setup(),k=await define(c,'running',8);await put(c,k,0);
    const index=await readFile(join(dir(root),k+'.index')),writer=await c.beginWrite(k,4,4);await writer.append(Buffer.alloc(8,5));
    const reserved=(await c.status(k)).reservedBytes;await c.discardSegment(k,0,4);
    expect(await c.status(k)).toMatchObject({producedThrough:4,complete:false,usedBytes:4096,reservedBytes:reserved});
    expect(await readFile(join(dir(root),k+'.index'))).toEqual(index);
    await writer.append(Buffer.alloc(8,5));await writer.commit();await c.markComplete(k);
    const completed=await readFile(join(dir(root),k+'.index'));await c.discardSegment(k,4,4);await c.close();
    const next=await openAudioSegmentCache(root,{headroomBytes:0});caches.push(next);
    expect(await next.status(k)).toMatchObject({producedThrough:8,complete:true,resident:[],reservedBytes:0});
    expect(await readFile(join(dir(root),k+'.index'))).toEqual(completed);await put(next,k,0);await next.close();
  });
  it('serializes duplicate discards without double-free, and does not discard pending regeneration',async()=>{
    const {c}=await setup(),k=await define(c);await put(c,k,0);
    await Promise.all([c.discardSegment(k,0,4),c.discardSegment(k,0,4)]);expect((await c.status(k)).usedBytes).toBe(4096);
    const writer=await c.beginWrite(k,0,4);await writer.append(Buffer.alloc(8,7));await c.discardSegment(k,0,4);
    expect((await c.status(k)).reservedBytes).toBe(5136);await writer.append(Buffer.alloc(8,7));await writer.commit();
    expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,7));await c.close();
  });
  it.each(['symlink','hardlink','directory'])('explicit discard refuses substituted %s and never removes the outside file',async kind=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const path=join(dir(root),`${k}-0-4.seg`),outside=join(root,'outside'),bytes=await readFile(path);await writeFile(outside,bytes);await unlink(path);
    if(kind==='symlink')await symlink(outside,path);else if(kind==='hardlink')await link(outside,path);else await mkdir(path);
    await expect(c.discardSegment(k,0,4)).rejects.toThrow('退避対象');expect(await readFile(outside)).toEqual(bytes);
    if(kind==='directory')await rm(path,{recursive:true});else await unlink(path);await writeFile(path,bytes);
    expect((await c.status(k)).usedBytes).toBe(5136);await c.close();
  });
  it('discard is exact-range only and never treats an unknown file as an owned resident',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);
    for(const [first,count] of [[0,2],[1,3],[0,5],[4,4],[-1,4],[0,0],[NaN,4],[0,Infinity],[Number.MAX_SAFE_INTEGER,1]]){
      await expect(Promise.resolve().then(()=>c.discardSegment(k,first!,count!))).rejects.toThrow();
    }
    await expect(Promise.resolve().then(()=>c.discardSegment('../escape',0,4))).rejects.toThrow();
    await expect(c.discardSegment(key('unknown'),0,4)).rejects.toThrow('未定義');
    const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);await c.discardSegment(k,0,4);await writeFile(path,bytes);
    await expect(c.discardSegment(k,0,4)).rejects.toThrow('未知');expect(await readFile(path)).toEqual(bytes);
    await unlink(path);await c.discardSegment(k,0,4);await c.close();
  });
  it('missing discard releases only its known accounting and leaves progress unchanged',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const index=await readFile(join(dir(root),k+'.index'));
    await unlink(join(dir(root),`${k}-0-4.seg`));await c.discardSegment(k,0,4);await c.discardSegment(k,0,4);
    expect(await c.status(k)).toMatchObject({usedBytes:4096,producedThrough:4,resident:[]});expect(await readFile(join(dir(root),k+'.index'))).toEqual(index);await c.close();
  });
  it.each(['discard','eviction'])('%s accepts ENOENT after lstat but never hides a non-ENOENT unlink failure',async mode=>{
    const {c}=await setup({budgetBytes:9232}),k=await define(c);await put(c,k,0);
    const action=async()=>{if(mode==='discard')return c.discardSegment(k,0,4);const w=await c.beginWrite(k,4,4);await w.abort();};
    faults.segmentUnlink=async()=>{throw Object.assign(new Error('blocked unlink'),{code:'EACCES'});};
    await expect(action()).rejects.toThrow('blocked unlink');faults.segmentUnlink=undefined;
    expect(await c.status(k)).toMatchObject({usedBytes:5136,reservedBytes:0,resident:[{first:0,count:4}]});expect(await c.withSegment(k,0,4,l=>l.read())).toEqual(Buffer.alloc(16,3));
    const real=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');faults.segmentUnlink=async path=>{await real.unlink(path);};
    await action();faults.segmentUnlink=undefined;expect(await c.status(k)).toMatchObject({usedBytes:4096,reservedBytes:0,producedThrough:4,resident:[]});await c.close();
  });
  it('abort before admission and after stat leaves resident intact; abort during unlink completes accounting',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path);
    const before=new AbortController();before.abort();await expect(c.discardSegment(k,0,4,before.signal)).rejects.toThrow();expect(await readFile(path)).toEqual(bytes);
    const statAbort=new AbortController();faults.segmentStat=async()=>{statAbort.abort();};
    await expect(c.discardSegment(k,0,4,statAbort.signal)).rejects.toThrow();faults.segmentStat=undefined;expect(await readFile(path)).toEqual(bytes);expect((await c.status(k)).usedBytes).toBe(5136);
    const unlinkAbort=new AbortController();faults.segmentUnlink=async()=>{unlinkAbort.abort();};await c.discardSegment(k,0,4,unlinkAbort.signal);faults.segmentUnlink=undefined;
    expect(await c.status(k)).toMatchObject({usedBytes:4096,resident:[]});await c.close();
  });
  it('index corruption and an abnormal lock cannot authorize discard',async()=>{
    const {root,c}=await setup(),k=await define(c);await put(c,k,0);const path=join(dir(root),`${k}-0-4.seg`),bytes=await readFile(path),index=join(dir(root),k+'.index'),original=await readFile(index),broken=Buffer.from(original);broken[20]=broken[20]!^1;await writeFile(index,broken);
    await expect(c.discardSegment(k,0,4)).rejects.toThrow();expect(await readFile(index)).toEqual(broken);expect(await readFile(path)).toEqual(bytes);await writeFile(index,original);
    await rm(join(dir(root),'.lock'),{recursive:true});await writeFile(join(dir(root),'.lock'),'not a lock directory');
    await expect(c.discardSegment(k,0,4)).rejects.toThrow('directory');expect(await readFile(path)).toEqual(bytes);
    await unlink(join(dir(root),'.lock'));await mkdir(join(dir(root),'.lock'));await c.close();
  });

});
