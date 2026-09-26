import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath, rename, statfs, unlink, rmdir, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';

export const AUDIO_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const HEADER = 1024, RECORD = 4096;
const hash = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export interface AudioSegmentStream {key: string; sampleRate: number; channels: number; totalFrames: number}
interface Progress extends AudioSegmentStream {producedThrough: number; complete: boolean}
interface Segment {key: string; first: number; count: number; sampleRate: number; channels: number; sha256: string}
interface Entry {meta: Segment; path: string; bytes: number; pins: number; age: number}
export interface AudioSegmentCacheOptions {
  budgetBytes?: number;
  headroomBytes?: number;
  /** Test override. Default is the filesystem allocation block size. */
  allocationUnitBytes?: number;
  /** Injectable disk availability probe for filesystem tests. Default: statfs.bavail*bsize. */
  availableBytes?: (directory: string) => Promise<bigint>;
}
export interface AudioSegmentLease {read(): Promise<Buffer>; release(): Promise<void>}
export interface AudioSegmentWriter {append(bytes: Uint8Array): Promise<void>; commit(): Promise<void>; abort(): Promise<void>}
const managers = new Map<string, Promise<AudioSegmentCache>>();
function integer(n: unknown, min = 0): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) throw new Error('音声cacheの整数が不正です');
}
function fields(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== [...names].sort().join()) throw new Error('音声cache metadataの形が不正です');
}
function key(k: unknown): asserts k is string {if (typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k)) throw new Error('音声cache keyが不正です');}
function spec(s: AudioSegmentStream) {
  key(s.key); integer(s.sampleRate, 1); integer(s.channels, 1); integer(s.totalFrames);
  if (s.sampleRate > 768000 || s.channels > 32) throw new Error('音声cache formatが不正です');
}
function pack(value: unknown, length: number): Buffer {
  const json = JSON.stringify(value), encoded = Buffer.from(JSON.stringify({json, sha256: hash(json)}));
  if (encoded.length + 4 > length) throw new Error('音声cache metadataが大きすぎます');
  const b = Buffer.alloc(length); b.writeUInt32LE(encoded.length); encoded.copy(b, 4); return b;
}
function unpack(b: Buffer): unknown {
  const size = b.readUInt32LE();
  if (!size || size > b.length - 4 || b.subarray(size + 4).some(n => n !== 0)) throw new Error('音声cache headerが不正です');
  const envelope: unknown = JSON.parse(b.subarray(4, 4 + size).toString()); fields(envelope, ['json', 'sha256']);
  if (typeof envelope.json !== 'string' || hash(envelope.json) !== envelope.sha256) throw new Error('音声cache metadata SHA不一致');
  return JSON.parse(envelope.json);
}
function parseProgress(v: unknown): Progress {
  fields(v, ['version', 'key', 'sampleRate', 'channels', 'totalFrames', 'producedThrough', 'complete']);
  if (v.version !== 1) throw new Error('音声cache version不正');
  const p = v as unknown as Progress; spec(p); integer(p.producedThrough);
  if (typeof p.complete !== 'boolean' || p.producedThrough > p.totalFrames || (p.complete && p.producedThrough !== p.totalFrames)) throw new Error('音声cache完了範囲が不正です');
  return p;
}
function parseSegment(v: unknown): Segment {
  fields(v, ['version','key','first','count','sampleRate','channels','sha256']);
  if (v.version !== 1) throw new Error('音声segment version不正');
  const s = v as unknown as Segment; key(s.key); key(s.sha256); integer(s.first); integer(s.count,1);
  spec({...s,totalFrames:s.first+s.count});
  if (s.count*s.channels*4 + HEADER > AUDIO_SEGMENT_MAX_BYTES) throw new Error('音声segmentが大きすぎます'); return s;
}
function id(s: Pick<Segment,'key'|'first'|'count'>) {return `${s.key}-${s.first}-${s.count}.seg`;}
async function regular(path: string): Promise<FileHandle> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const s = await f.stat(); if (!s.isFile() || s.nlink !== 1) throw new Error('音声cacheは通常の非共有ファイルに限ります'); return f;} catch(e) {await f.close(); throw e;}
}
async function writeAll(f: FileHandle, b: Uint8Array, offset: number) {
  let at = 0; while(at < b.byteLength) {const {bytesWritten} = await f.write(b, at, b.byteLength-at, offset+at); if (!bytesWritten) throw new Error('音声cache書込停止'); at += bytesWritten;}
}
async function readAll(f: FileHandle, length: number, offset = 0) {
  const b = Buffer.alloc(length); let at = 0;
  while(at < length) {const {bytesRead} = await f.read(b, at, length-at, offset+at); if (!bytesRead) throw new Error('音声cache欠損'); at += bytesRead;} return b;
}
async function safeDirectory(project: string) {
  let dir = project;
  for (const part of ['.harness','cache','audio-segments-v1']) {
    dir=join(dir,part); await mkdir(dir).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const s=await lstat(dir); if(s.isSymbolicLink()||!s.isDirectory())throw new Error('音声cache directory不正');
  }
  return dir;
}

/** One canonical project manager per process. A directory lock rejects other processes. */
export async function openAudioSegmentCache(project: string, options: AudioSegmentCacheOptions = {}): Promise<AudioSegmentCache> {
  const root = await realpath(project);
  const prior = managers.get(root);
  if (prior) {const cache = await prior; cache.matchOptions(options); return cache;}
  const pending = AudioSegmentCache.create(root, options);
  managers.set(root,pending);
  try {return await pending;} catch(e) {if(managers.get(root)===pending)managers.delete(root); throw e;}
}

export class AudioSegmentCache {
  private records = new Map<string, Progress>();
  private entries = new Map<string,Entry>();
  private writers = new Map<string, {cancel:()=>Promise<void>}>();
  private used = 0;
  private reserved = 0;
  private unwritten = 0;
  private clock = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private fault: unknown;
  private constructor(private root:string, private directory:string, private budget:number, private headroom:number, private allocationUnit:number, private available:(directory:string)=>Promise<bigint>) {}
  static async create(root:string, options:AudioSegmentCacheOptions) {
    const budget=options.budgetBytes??8*1024**3, headroom=options.headroomBytes??1024**3;
    integer(budget,1); integer(headroom);
    const directory=await safeDirectory(root), lock=join(directory,'.lock');
    const allocationUnit=options.allocationUnitBytes??Number((await statfs(directory,{bigint:true})).bsize);integer(allocationUnit,1);
    await mkdir(lock); // Never steal a lock based on PID or age.
    const c=new AudioSegmentCache(root,directory,budget,headroom,allocationUnit,options.availableBytes??(async p=>{const s=await statfs(p,{bigint:true});return s.bavail*s.bsize;}));
    try {await c.restore(); await c.ensure(0,0,false); return c;} catch(e) {await rmdir(lock);throw e;}
  }
  matchOptions(o:AudioSegmentCacheOptions) {
    if ((o.budgetBytes!==undefined&&o.budgetBytes!==this.budget)||(o.headroomBytes!==undefined&&o.headroomBytes!==this.headroom)||(o.allocationUnitBytes!==undefined&&o.allocationUnitBytes!==this.allocationUnit)||(o.availableBytes!==undefined&&o.availableBytes!==this.available)) throw new Error('共有音声cacheの設定が異なります');
  }
  private serial<T>(f:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(async()=>{if(this.closed)throw new Error('音声cacheは閉じています');if(this.fault)throw this.fault;await this.checkDirectories();return f();});
    this.queue=next.catch(()=>undefined); return next;
  }
  private async checkDirectories() {
    let p=this.root;for(const name of ['.harness','cache','audio-segments-v1','.lock']) {p=join(p,name);const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('音声cache directory変更');}
  }
  private async readRecord(path:string) {const f=await regular(path);try{if((await f.stat()).size!==RECORD)throw new Error('音声cache index長不正');return parseProgress(unpack(await readAll(f,RECORD)));}finally{await f.close();}}
  private async verifyHeader(entry:Entry,f:FileHandle) {
    if((await f.stat()).size!==entry.bytes)throw new Error('音声cache PCM長不正');
    const metadata=parseSegment(unpack(await readAll(f,HEADER)));
    if(JSON.stringify(metadata)!==JSON.stringify(entry.meta))throw new Error('音声cache metadata変更');
    return metadata;
  }
  private async verify(entry:Entry) {
    const f=await regular(entry.path);
    try {const metadata=await this.verifyHeader(entry,f);
      const bytes=await readAll(f,entry.bytes-HEADER,HEADER);if(hash(bytes)!==metadata.sha256)throw new Error('音声cache PCM SHA不一致');return bytes;
    }finally{await f.close();}
  }
  private async restore() {
    await this.checkDirectories();const names=await readdir(this.directory);
    for(const name of names) {
      if(name==='.lock')continue;
      const path=join(this.directory,name), s=await lstat(path);
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('音声cacheに不正なファイル');
      if (/^pending-[a-f0-9-]+\.tmp$/.test(name)) {await unlink(path);continue;}
      if (/^[a-f0-9]{64}\.index$/.test(name)) {const p=await this.readRecord(path);if(name!==p.key+'.index')throw new Error('音声cache index key不一致');this.records.set(p.key,p);this.used+=RECORD;}
      else if(!/^[a-f0-9]{64}-\d+-\d+\.seg$/.test(name))throw new Error('未知の音声cacheファイル');
    }
    for(const name of names.filter(n=>n.endsWith('.seg'))) {
      const path=join(this.directory,name),f=await regular(path);let s:Segment;
      try {s=parseSegment(unpack(await readAll(f,HEADER)));}finally{await f.close();}
      const progress=this.records.get(s.key);
      if(name!==id(s)||!progress||s.channels!==progress.channels||s.sampleRate!==progress.sampleRate||s.first+s.count>progress.producedThrough)throw new Error('音声cache segment/index不一致');
      const e:Entry={path,meta:s,bytes:HEADER+s.count*s.channels*4,pins:0,age:++this.clock};await this.verify(e);
      if([...this.entries.values()].some(x=>x.meta.key===s.key&&x.meta.first<s.first+s.count&&s.first<x.meta.first+x.meta.count))throw new Error('音声cache区間重複');
      this.entries.set(name,e);this.used+=e.bytes;
    }
  }
  private allocation(bytes:number) {return Math.ceil(bytes/this.allocationUnit)*this.allocationUnit;}
  private async ensure(extra:number, diskExtra=this.allocation(extra), checkHeadroom=true) {
    integer(extra);integer(diskExtra);
    for(;;) {
      // Opening for reads enforces logical capacity, not a future writer's disk reserve.
      let diskReady=true;
      if(checkHeadroom){
        const free=await this.available(this.directory);
        if(free<0n)throw new Error('音声cache空き容量不正');
        diskReady=free-BigInt(this.unwritten)-BigInt(diskExtra)>=BigInt(this.headroom);
      }
      if(BigInt(this.used)+BigInt(this.reserved)+BigInt(extra)<=BigInt(this.budget)&&diskReady)return;
      const victim=[...this.entries.values()].filter(e=>!e.pins).sort((a,b)=>a.age-b.age)[0];
      if(!victim)throw new Error('音声cache容量不足（pin・予約またはdisk headroom）');
      await this.removeEntry(victim);
    }
  }
  /** Discard is not a read. Only a known, unpinned regular file (or its absence) may be forgotten. */
  private async removeEntry(entry:Entry, signal?:AbortSignal) {
    signal?.throwIfAborted();
    if(entry.pins)throw new Error('音声cache leaseを先に解放してください');
    let missing=false;
    try{
      const file=await lstat(entry.path);
      if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new Error('音声cache退避対象が不正です');
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;}
    signal?.throwIfAborted();
    if(!missing){
      try{await unlink(entry.path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    // Successful unlink / observed ENOENT is the boundary. Complete accounting even if abort arrived during unlink.
    this.entries.delete(id(entry.meta));this.used-=entry.bytes;
  }
  /** Explicit producer recovery. No automatic miss on corruption; history/complete are never retracted. */
  discardSegment(streamKey:string, first:number, count:number, signal?:AbortSignal):Promise<void> {
    key(streamKey);integer(first);integer(count,1);
    return this.serial(async()=>{
      signal?.throwIfAborted();const p=await this.require(streamKey);integer(first+count);
      if(first+count>p.producedThrough||count*p.channels*4+HEADER>AUDIO_SEGMENT_MAX_BYTES)throw new Error('音声cache破棄範囲不正');
      const name=id({key:streamKey,first,count}),entry=this.entries.get(name);
      if(entry){await this.removeEntry(entry,signal);return;}
      if([...this.entries.values()].some(e=>e.meta.key===streamKey&&e.meta.first<first+count&&first<e.meta.first+e.meta.count))throw new Error('音声cache破棄は確定segment全範囲を指定してください');
      // No resident means idempotent absence, never permission to delete an untracked file.
      try{await lstat(join(this.directory,name));}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;signal?.throwIfAborted();return;
      }
      throw new Error('音声cacheに未知のsegmentがあります');
    });
  }
  private async replaceProgress(p:Progress, temporary:string, signal?:AbortSignal) {
    if(this.records.has(p.key))await this.require(p.key);
    const f=await open(temporary,'wx',0o600);
    try{await writeAll(f,pack({version:1,...p},RECORD),0);await f.sync();}finally{await f.close();}
    if(this.records.has(p.key))await this.require(p.key);
    signal?.throwIfAborted();await rename(temporary,join(this.directory,p.key+'.index'));this.records.set(p.key,p);
  }
  defineStream(input:AudioSegmentStream, signal?:AbortSignal):Promise<void> {
    fields(input,['key','sampleRate','channels','totalFrames']);spec(input);const s={...input};
    return this.serial(async()=>{
      signal?.throwIfAborted();const old=this.records.has(s.key)?await this.require(s.key):undefined;
      if(old){if(old.channels!==s.channels||old.sampleRate!==s.sampleRate||old.totalFrames!==s.totalFrames)throw new Error('音声cache key/format衝突');return;}
      await this.ensure(RECORD);signal?.throwIfAborted();const tmp=join(this.directory,`pending-${randomUUID()}.tmp`);
      try{await this.replaceProgress({...s,producedThrough:0,complete:false},tmp,signal);this.used+=RECORD;}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    });
  }
  beginWrite(streamKey:string, first:number, count:number, signal?:AbortSignal):Promise<AudioSegmentWriter> {
    key(streamKey);integer(first);integer(count,1);
    return this.serial(async()=>{
      signal?.throwIfAborted();const p=await this.require(streamKey);integer(first+count);
      const bytes=count*p.channels*4, total=bytes+HEADER, reservation=total+RECORD;
      const diskReservation=this.allocation(total)+this.allocation(RECORD);
      if(total>AUDIO_SEGMENT_MAX_BYTES||first+count>p.totalFrames||first>p.producedThrough||(first<p.producedThrough&&first+count>p.producedThrough))throw new Error('音声cache書込範囲不正');
      if(this.writers.has(streamKey)||[...this.entries.values()].some(e=>e.meta.key===streamKey&&e.meta.first<first+count&&first<e.meta.first+e.meta.count))throw new Error('音声cache書込が重複しています');
      await this.ensure(reservation,diskReservation);signal?.throwIfAborted();
      const temp=join(this.directory,`pending-${randomUUID()}.tmp`), metaTemp=join(this.directory,`pending-${randomUUID()}.tmp`);
      const f=await open(temp,'wx',0o600);this.reserved+=reservation;this.unwritten+=diskReservation;
      let ended=false, appendPending=false, closing=false, written=0, diskBytes=0, publishedPath: string | undefined;const checksum=createHash('sha256');
      const release=()=>{ended=true;signal?.removeEventListener('abort',onAbort);this.writers.delete(streamKey);this.reserved-=reservation;this.unwritten-=diskReservation-diskBytes;};
      const cancel=async()=>{if(ended)return;await f.close();await unlink(publishedPath??temp);await unlink(metaTemp).catch(e=>{if(e.code!=='ENOENT')throw e;});release();};
      const onAbort=()=>{void this.serial(cancel).catch(e=>{this.fault=e;});};
      const check=()=>{if(ended)throw new Error('音声cache writerは終了しています');signal?.throwIfAborted();};
      this.writers.set(streamKey,{cancel});signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted){await cancel();signal.throwIfAborted();}
      return {
        append:(input:Uint8Array)=>{
          // Admission precedes owned-copy allocation. Do not enqueue caller payloads behind I/O.
          if(ended||closing||signal?.aborted)return Promise.reject(new Error('音声cache writerは終了・取消中です'));
          if(appendPending)return Promise.reject(new Error('音声cache appendは1件ずつawaitしてください'));
          if(!(input instanceof Uint8Array)||input.byteLength>bytes-written){
            closing=true;return this.serial(async()=>{await cancel();throw new Error('音声cache予約長超過または入力形式不正');});
          }
          appendPending=true;let copy:Buffer;
          try{copy=Buffer.from(input);}catch(error){appendPending=false;closing=true;return this.serial(async()=>{await cancel();throw error;});}
          const work=this.serial(async()=>{try{check();if(copy.length===0)return;await this.ensure(0);await this.require(streamKey);check();await writeAll(f,copy,HEADER+written);checksum.update(copy);written+=copy.length;
            const newDisk=this.allocation(HEADER+written);this.unwritten-=newDisk-diskBytes;diskBytes=newDisk;
          }catch(e){await cancel();throw e;}});
          return work.finally(()=>{appendPending=false;});
        },
        commit:()=>{closing=true;return this.serial(async()=>{
          try{check();if(written!==bytes)throw new Error('音声cache PCM不足');await this.ensure(0);await this.require(streamKey);check();
            const m:Segment={key:streamKey,first,count,sampleRate:p.sampleRate,channels:p.channels,sha256:checksum.digest('hex')};
            await writeAll(f,pack({version:1,...m},HEADER),0);await f.sync();check();
            const next={...p,producedThrough:Math.max(p.producedThrough,first+count)};
            await f.close();check();await rename(temp,join(this.directory,id(m)));publishedPath=join(this.directory,id(m));
            check();await this.replaceProgress(next,metaTemp,signal);this.unwritten-=this.allocation(RECORD);diskBytes+=this.allocation(RECORD);
            // Index rename is the commit boundary. A later cancellation does not retract committed data.
            this.entries.set(id(m),{meta:{version:1,...m} as Segment,path:join(this.directory,id(m)),bytes:total,pins:0,age:++this.clock});this.used+=total;release();
          }catch(e){await cancel();throw e;}
        });},
        abort:()=>{closing=true;return this.serial(cancel);},
      };
    });
  }
  private async require(k:string) {
    const p=this.records.get(k);if(!p)throw new Error('音声cache stream未定義');
    const saved=await this.readRecord(join(this.directory,k+'.index'));
    if(!pack({version:1,...p},RECORD).equals(pack({version:1,...saved},RECORD)))throw new Error('音声cache index変更');return p;
  }
  acquire(streamKey:string,first:number,count:number,signal?:AbortSignal):Promise<AudioSegmentLease|null> {
    key(streamKey);integer(first);integer(count,1);
    return this.serial(async()=>{
      signal?.throwIfAborted();const p=await this.require(streamKey);integer(first+count);if(first+count>p.totalFrames)throw new Error('音声cache読出し範囲不正');const e=this.entries.get(id({key:streamKey,first,count}));if(!e)return null;
      await this.verify(e);signal?.throwIfAborted();e.pins++;let released=false;
      const release=()=>this.serial(async()=>{if(!released){released=true;e.pins--;e.age=++this.clock;signal?.removeEventListener('abort',onAbort);}});
      const onAbort=()=>{void release().catch(error=>{this.fault=error;});};signal?.addEventListener('abort',onAbort,{once:true});
      return {read:()=>this.serial(async()=>{if(released)throw new Error('音声cache lease解放済み');signal?.throwIfAborted();const b=await this.verify(e);signal?.throwIfAborted();return b;}),release};
    });
  }
  async withSegment<T>(streamKey:string,first:number,count:number,consume:(lease:AudioSegmentLease)=>Promise<T>,signal?:AbortSignal):Promise<T|null> {
    const lease=await this.acquire(streamKey,first,count,signal);if(!lease)return null;try{return await consume(lease);}finally{await lease.release();}
  }
  markComplete(streamKey:string,signal?:AbortSignal):Promise<void> {
    key(streamKey);return this.serial(async()=>{
      signal?.throwIfAborted();const p=await this.require(streamKey);if(p.complete)return;
      if(p.producedThrough!==p.totalFrames||this.writers.has(streamKey))throw new Error('音声cache生成未完了');
      await this.ensure(RECORD);signal?.throwIfAborted();const tmp=join(this.directory,`pending-${randomUUID()}.tmp`);
      try{await this.replaceProgress({...p,complete:true},tmp,signal);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    });
  }
  status(streamKey:string) {
    key(streamKey);return this.serial(async()=>{
      const p=await this.require(streamKey), resident=[];
      // Availability metadata only: PCM SHA is still mandatory at acquire and every read.
      for(const e of this.entries.values())if(e.meta.key===streamKey){
        const f=await regular(e.path);try{await this.verifyHeader(e,f);}finally{await f.close();}
        resident.push({first:e.meta.first,count:e.meta.count});
      }
      return {producedThrough:p.producedThrough,complete:p.complete,resident:resident.sort((a,b)=>a.first-b.first),usedBytes:this.used,reservedBytes:this.reserved,pinnedSegments:[...this.entries.values()].filter(e=>e.pins).length};
    });
  }
  close():Promise<void> {return this.serial(async()=>{
    if([...this.entries.values()].some(e=>e.pins))throw new Error('音声cache leaseを先に解放してください');
    for(const w of this.writers.values())await w.cancel();await rmdir(join(this.directory,'.lock'));this.closed=true;managers.delete(this.root);
  });}
}
