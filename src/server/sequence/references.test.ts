import {afterEach,expect,it,vi} from 'vitest';
const fault=vi.hoisted(()=>({fail:false,foreign:false,afterLink:null as (()=>Promise<void>)|null,probeChanged:false,probeChangedApplied:0}));
vi.mock('node:fs/promises',async load=>{const fs=await load<typeof import('node:fs/promises')>();return {...fs,symlink:async(...args:Parameters<typeof fs.symlink>)=>{if(fault.fail){fault.fail=false;if(fault.foreign)await fs.writeFile(args[1],'foreign');throw new Error('injected publication failure');}await fs.symlink(...args);const callback=fault.afterLink;fault.afterLink=null;await callback?.();}};});
vi.mock('./media',async load=>{const actual=await load<typeof import('./media')>();return {...actual,probeSequenceAssetSource:async(...args:Parameters<typeof actual.probeSequenceAssetSource>)=>{const probed=await actual.probeSequenceAssetSource(...args);if(fault.probeChanged){fault.probeChangedApplied++;probed.asset.streams=probed.asset.streams.map(stream=>({...stream,duration:{num:999,den:1}}));}return probed;}};});
import {realpath,mkdtemp,mkdir,writeFile,readFile,readdir,lstat,stat,rename,unlink,symlink,rm,utimes,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isSequenceReferenceFile,registerSequenceReference,registeredSequenceReferences,openSequenceReference,reconnectSequenceReference,sequenceReferenceStatus} from './references';
import {serializeSequence,parseSequence} from '../../core/sequence/validate';
const owned:string[]=[];
afterEach(async()=>{fault.fail=false;fault.foreign=false;fault.afterLink=null;fault.probeChanged=false;fault.probeChangedApplied=0;for(const root of owned.splice(0))await rm(root,{recursive:true,force:true});});
function wav(){const b=Buffer.alloc(44+1600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1600,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%100,i);return b;}
async function fixture(){const root=await mkdtemp(join(tmpdir(),'harness-reference-'));owned.push(root);const project=join(root,'project'),source=join(root,'source.wav');await mkdir(project);await writeFile(source,wav());return {root,project,source};}
it('rejects a replaced File selection fingerprint before publishing any reference',async()=>{
 const f=await fixture(),before=await readFile(f.source);
 await expect(registerSequenceReference(f.project,f.source,'source.wav',undefined,'a'.repeat(64))).rejects.toThrow('指紋');
 expect(await readdir(f.project)).toEqual([]);expect(await readFile(f.source)).toEqual(before);
});
it('accepts the exact full File fingerprint and rejects malformed expectations',async()=>{
 const f=await fixture(),fingerprint=createHash('sha256').update(wav()).digest('hex');
 const asset=await registerSequenceReference(f.project,f.source,'表示名.wav',undefined,fingerprint);expect(asset.fingerprint).toBe(fingerprint);
 await expect(registerSequenceReference(f.project,f.source,'source.wav',undefined,'not-a-full-hash')).rejects.toThrow('指紋');
 expect(await registeredSequenceReferences(f.project)).toEqual([asset]);
});
it('rolls back only newly published leaves when source changes between inspection and final verify',async()=>{
 const f=await fixture(),bytes=wav(),changed=Buffer.from(bytes);changed[100]=1;
 fault.afterLink=()=>writeFile(f.source,changed);
 await expect(registerSequenceReference(f.project,f.source,'source.wav',undefined,createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow('一致');
 expect(await readdir(join(f.project,'.harness/references'))).toEqual([]);expect(await readFile(f.source)).toEqual(changed);
});
it('reads and reconnects an asset after canonical document storage reorders nested stream keys',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source);
 const d=parseSequence(serializeSequence({schemaVersion:2,id:'saved',name:'saved',revision:0,fps:{num:30,den:1},resolution:{width:1,height:1},sequenceEndFrame:0,background:'#000',assets:[asset],tracks:[],clips:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}}));
 const saved=d.assets[0]!;expect(saved).toEqual(asset);expect(JSON.stringify(saved.streams)).not.toBe(JSON.stringify(asset.streams));
 const lease=await openSequenceReference(f.project,saved);await lease.verify();await lease.close();
 const moved=join(f.root,'moved.wav');await rename(f.source,moved);await reconnectSequenceReference(f.project,saved,moved);expect((await sequenceReferenceStatus(f.project,saved)).state).toBe('ok');
});
it('recognizes only explicit reference media paths, not generic assets, components or traversal',()=>{
 const hash='a'.repeat(64);expect(isSequenceReferenceFile(`.harness/references/${hash}.mov`)).toBe(true);
 for(const p of [`/tmp/${hash}.mp4`,`.harness/assets/${hash}.mp4`,`.harness/references/../${hash}.mp4`,`.harness/references/${hash}.js`,`.harness/references/${hash}.cube`])expect(isSequenceReferenceFile(p)).toBe(false);
});
it('registers metadata plus one leaf symlink without copying source bytes and preserves exact streams',async()=>{
 const f=await fixture(),before=await stat(f.source),asset=await registerSequenceReference(f.project,f.source,'音声.wav');
 expect(asset.fingerprint).toBe(createHash('sha256').update(wav()).digest('hex'));expect(asset.streams[0]).toMatchObject({kind:'audio',duration:{num:1,den:10},sampleRate:8000,channels:1});
 expect((await lstat(join(f.project,asset.file))).isSymbolicLink()).toBe(true);expect(await readlink(join(f.project,asset.file))).toBe(await realpath(f.source));
 expect(await readdir(join(f.project,'.harness/references'))).toEqual(expect.arrayContaining([asset.file.split('/').at(-1),asset.file.split('/').at(-1)+'.json']));
 expect((await readdir(join(f.project,'.harness/references'))).length).toBe(2);expect(await stat(f.source)).toMatchObject({ino:before.ino,size:before.size,mtimeMs:before.mtimeMs});
 const lease=await openSequenceReference(f.project,asset);try{const b=Buffer.alloc(4);await lease.handle.read(b,0,4,0);expect(b.toString()).toBe('RIFF');await lease.verify();}finally{await lease.close();await lease.close();}
 expect(await registeredSequenceReferences(f.project)).toEqual([asset]);expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('ok');
});
it('keeps offline assets listed and reconnects identical bytes at another path without changing the asset',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),moved=join(f.root,'moved.wav');await rename(f.source,moved);
 expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('missing');expect(await registeredSequenceReferences(f.project)).toEqual([asset]);
 expect(await reconnectSequenceReference(f.project,asset,moved)).toEqual(asset);expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('ok');expect(await readFile(moved)).toEqual(wav());
});
it('accepts a selected symlink and reconnects after the external volume path changes without copying',async()=>{
 const f=await fixture(),selection=join(f.root,'selected.wav');await symlink(f.source,selection);
 const asset=await registerSequenceReference(f.project,selection),saved=structuredClone(asset);
 expect((await lstat(join(f.project,asset.file))).isSymbolicLink()).toBe(true);
 expect(await readlink(join(f.project,asset.file))).toBe(await realpath(f.source));
 const reattached=join(f.root,'reattached.wav');await rename(f.source,reattached);
 expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('missing');
 await reconnectSequenceReference(f.project,asset,reattached);expect(asset).toEqual(saved);
 expect((await lstat(join(f.project,asset.file))).isSymbolicLink()).toBe(true);
 expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('ok');
 expect(await readdir(join(f.project,'.harness'))).toEqual(['references']);
});
it('rejects changed bytes even when size and mtime are restored, without trusting cached verification',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),lease=await openSequenceReference(f.project,asset),old=await stat(f.source);
 const changed=wav();changed[100]=changed[100]!^1;await writeFile(f.source,changed);await utimes(f.source,old.atime,old.mtime);
 try{await expect(lease.verify()).rejects.toThrow('変更');}finally{await lease.close();}
 expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('mismatch');await expect(reconnectSequenceReference(f.project,asset,f.source)).rejects.toThrow('一致');
});
it('rejects a replaced path while an old fd is still readable, and retires a lease on identical reconnect',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),lease=await openSequenceReference(f.project,asset),same=join(f.root,'same.wav');await writeFile(same,wav());
 await reconnectSequenceReference(f.project,asset,same);try{await expect(lease.verify()).rejects.toThrow('変更');}finally{await lease.close();}
 const current=await openSequenceReference(f.project,asset);await rename(same,same+'.old');await writeFile(same,wav());try{await expect(current.verify()).rejects.toThrow('変更');}finally{await current.close();}
});
it('refuses ordinary files in a reference leaf and never removes or overwrites them',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),leaf=join(f.project,asset.file);await unlink(leaf);await writeFile(leaf,'foreign');
 await expect(reconnectSequenceReference(f.project,asset,f.source)).rejects.toThrow('不正');expect(await readFile(leaf,'utf8')).toBe('foreign');expect(await readFile(f.source)).toEqual(wav());
});
it('rejects parent symlinks, malformed records and unregistered external links',async()=>{
 const f=await fixture(),outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,join(f.project,'.harness'));
 await expect(registerSequenceReference(f.project,f.source)).rejects.toThrow('ディレクトリ');expect(await readdir(outside)).toEqual([]);
 await unlink(join(f.project,'.harness'));const asset=await registerSequenceReference(f.project,f.source),record=join(f.project,asset.file)+'.json';
 await writeFile(record,'{}');await expect(registeredSequenceReferences(f.project)).rejects.toThrow();await unlink(record);await expect(openSequenceReference(f.project,asset)).rejects.toThrow();
});
it('rejects tampered stream metadata or a symlink record instead of treating it as managed data',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),record=join(f.project,asset.file)+'.json',original=await readFile(record,'utf8');
 const data=JSON.parse(original);data.asset.streams[0].duration={num:2,den:10};await writeFile(record,JSON.stringify(data));await expect(openSequenceReference(f.project,asset)).rejects.toThrow('一致');
 await unlink(record);const external=join(f.root,'record.json');await writeFile(external,original);await symlink(external,record);await expect(openSequenceReference(f.project,asset)).rejects.toThrow();expect(await readFile(external,'utf8')).toBe(original);expect(JSON.stringify(await sequenceReferenceStatus(f.project,asset))).not.toContain(f.project);expect(JSON.stringify(await sequenceReferenceStatus(f.project,asset))).not.toContain(await realpath(f.project));
});
it('keeps unrelated directory contents and refuses an incomplete mutation marker',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references');await writeFile(join(dir,'unknown'),'keep');await writeFile(join(dir,'.mutation-lock'),'incomplete');
 await expect(reconnectSequenceReference(f.project,asset,f.source)).rejects.toThrow('未完了');await expect(openSequenceReference(f.project,asset)).rejects.toThrow('変更');expect(await readFile(join(dir,'unknown'),'utf8')).toBe('keep');
});
it('cancels without creating source copies or mutating the original',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();await expect(registerSequenceReference(f.project,f.source,undefined,controller.signal)).rejects.toThrow();expect(await readdir(f.project)).toEqual([]);expect(await readFile(f.source)).toEqual(wav());
});
it('does not report successful duplicate registration while the original target has changed',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());
 const changed=wav();changed[100]=changed[100]!^1;await writeFile(f.source,changed);
 await expect(registerSequenceReference(f.project,same)).rejects.toThrow('一致');
 expect(await registeredSequenceReferences(f.project)).toEqual([asset]);expect(await readFile(f.source)).toEqual(changed);
});
it('registers an actual image through the same no-copy path',async()=>{
 const f=await fixture(),png=join(f.root,'pixel.png');await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64'));
 const asset=await registerSequenceReference(f.project,png);expect(asset.kind).toBe('image');expect(asset.streams).toEqual([]);expect((await lstat(join(f.project,asset.file))).isSymbolicLink()).toBe(true);
});
it('restores the old registered link when reconnect publication fails, without copying media',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());fault.fail=true;
 await expect(reconnectSequenceReference(f.project,asset,same)).rejects.toThrow('injected');expect(await readlink(join(f.project,asset.file))).toBe(await realpath(f.source));
 expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('ok');expect(await readdir(join(f.project,'.harness/references'))).toHaveLength(2);
});
it('preserves unexpected objects, backups and incomplete lock when rollback cannot safely finish',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());fault.fail=true;fault.foreign=true;
 await expect(reconnectSequenceReference(f.project,asset,same)).rejects.toThrow('未完了');expect(await readFile(join(f.project,asset.file),'utf8')).toBe('foreign');
 const names=await readdir(join(f.project,'.harness/references'));expect(names).toContain('.mutation-lock');expect(names.filter(n=>n.startsWith('.previous-'))).toHaveLength(2);
 await expect(openSequenceReference(f.project,asset)).rejects.toThrow('変更');expect(await readFile(f.source)).toEqual(wav());expect(await readFile(same)).toEqual(wav());
});

it('keeps saved streams when identical bytes are probed differently during reconnect and duplicate registration',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());fault.probeChanged=true;
 expect(await reconnectSequenceReference(f.project,asset,same)).toEqual(asset);
 expect(await registerSequenceReference(f.project,same)).toEqual(asset);
 expect(await registeredSequenceReferences(f.project)).toEqual([asset]);const lease=await openSequenceReference(f.project,asset);await lease.close();
 expect(fault.probeChangedApplied).toBe(2);
});
it('automatically clears a verifiably dead idle mutation owner without deleting unrelated leaves',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references');
 await writeFile(join(dir,'unknown'),'keep');await writeFile(join(dir,'.mutation-lock'),JSON.stringify({format:'harness-reference-mutation',version:1,pid:2147483647,startedAt:1,token:'12345678-1234-4234-8234-123456789012'}));
 const lease=await openSequenceReference(f.project,asset);await lease.close();expect(await readFile(join(dir,'unknown'),'utf8')).toBe('keep');expect(await readdir(dir)).not.toContain('.mutation-lock');
});

const deadJournal=()=>({format:'harness-reference-mutation',version:1,pid:2147483647,startedAt:1,token:'12345678-1234-4234-8234-123456789012'});
const ownedInode=(s:{dev:number;ino:number})=>({dev:s.dev,ino:s.ino});
it.each(['before-move','link-moved','pair-moved','new-link','committed'])('recovers dead reconnect at %s using recorded inode ownership',async stage=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());
 const dir=join(f.project,'.harness/references'),leaf=join(f.project,asset.file),metadata=leaf+'.json',original=await readFile(metadata,'utf8');
 const backup='.previous-12345678-1234-4234-8234-123456789012',b=join(dir,backup);
 const transaction={file:asset.file,backup,before:{record:ownedInode(await lstat(metadata)),link:ownedInode(await lstat(leaf))},owned:{} as {link?:{dev:number;ino:number};record?:{dev:number;ino:number}},committed:false};
 if(stage!=='before-move')await rename(leaf,b);
 if(!['before-move','link-moved'].includes(stage))await rename(metadata,b+'.json');
 if(['new-link','committed'].includes(stage)){await symlink(await realpath(same),leaf);transaction.owned.link=ownedInode(await lstat(leaf));}
 if(stage==='committed'){const record=JSON.parse(original);record.target=await realpath(same);record.generation='22345678-1234-4234-8234-123456789012';await writeFile(metadata,JSON.stringify(record)+'\n');transaction.owned.record=ownedInode(await lstat(metadata));transaction.committed=true;}
 await writeFile(join(dir,'.mutation-lock'),JSON.stringify({...deadJournal(),transaction}));
 const lease=await openSequenceReference(f.project,asset);await lease.close();
 expect(await readlink(leaf)).toBe(await realpath(stage==='committed'?same:f.source));
 if(stage!=='committed')expect(await readFile(metadata,'utf8')).toBe(original);
 expect(await registeredSequenceReferences(f.project)).toEqual([asset]);expect((await readdir(dir)).sort()).toEqual([leaf.split('/').at(-1)!,metadata.split('/').at(-1)!].sort());
 expect(await readFile(f.source)).toEqual(wav());expect(await readFile(same)).toEqual(wav());
});
it('does not reclaim a live PID or remove foreign leaves during dead-owner recovery',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references'),lock=join(dir,'.mutation-lock'),leaf=join(f.project,asset.file),metadata=leaf+'.json';
 const active=JSON.stringify({...deadJournal(),pid:process.pid});await writeFile(lock,active);
 await expect(openSequenceReference(f.project,asset)).rejects.toThrow('完了後');expect(await readFile(lock,'utf8')).toBe(active);expect((await sequenceReferenceStatus(f.project,asset)).state).toBe('invalid');
 const backup='.previous-12345678-1234-4234-8234-123456789012',b=join(dir,backup),transaction={file:asset.file,backup,before:{record:ownedInode(await lstat(metadata)),link:ownedInode(await lstat(leaf))},owned:{}};
 await rename(leaf,b);await rename(metadata,b+'.json');await writeFile(leaf,'foreign');const bytes=JSON.stringify({...deadJournal(),transaction});await writeFile(lock,bytes);
 await expect(openSequenceReference(f.project,asset)).rejects.toThrow('所有不明');expect(await readFile(lock,'utf8')).toBe(bytes);expect(await readFile(leaf,'utf8')).toBe('foreign');expect(await readlink(b)).toBe(await realpath(f.source));expect((await readdir(dir)).filter(n=>n.startsWith('.previous-'))).toHaveLength(2);
});
it('recovers owned incomplete registration but retains unknown old markers with actionable diagnostics',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references'),leaf=join(f.project,asset.file),metadata=leaf+'.json',lock=join(dir,'.mutation-lock');
 await unlink(metadata);await writeFile(lock,JSON.stringify({...deadJournal(),transaction:{file:asset.file,owned:{link:ownedInode(await lstat(leaf))}}}));
 expect(await registeredSequenceReferences(f.project)).toEqual([]);expect(await readdir(dir)).toEqual([]);
 await writeFile(lock,'');await expect(registerSequenceReference(f.project,f.source)).rejects.toThrow('再起動');expect(await readFile(lock,'utf8')).toBe('');
});
it('keeps exact document-to-record streams validation even when a new probe is allowed to differ',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),tampered=structuredClone(asset);tampered.streams[0]!.duration={num:5,den:1};fault.probeChanged=true;
 await expect(reconnectSequenceReference(f.project,tampered,f.source)).rejects.toThrow('文書と台帳');expect(await registeredSequenceReferences(f.project)).toEqual([asset]);
 expect(fault.probeChangedApplied).toBe(1);
});

it('recovers after a real child SIGKILL between old-pair backup and new-link publication',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),same=join(f.root,'same.wav');await writeFile(same,wav());
 const script=join(f.root,'crash.cjs'),payload=join(f.root,'request.json');await writeFile(payload,JSON.stringify({project:f.project,asset,source:same}));
 await writeFile(script,`const fs=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');const original=fs.rename;
fs.rename=async (...args)=>{const result=await original(...args);if(String(args[1]).includes('/.previous-')&&String(args[1]).endsWith('.json'))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();
(async()=>{const request=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const {reconnectSequenceReference}=await import(process.argv[3]);await reconnectSequenceReference(request.project,request.asset,request.source);})().catch(e=>{console.error(e);process.exitCode=1;});`);
 const child=spawn(process.execPath,['--import','tsx',script,payload,new URL('./references.ts',import.meta.url).href],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',data=>{stderr+=String(data);});
 const ended=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 expect({ended,stderr}).toEqual({ended:{code:null,signal:'SIGKILL'},stderr:''});
 const dir=join(f.project,'.harness/references'),record=JSON.parse(await readFile(join(dir,'.mutation-lock'),'utf8'));expect(record.pid).toBe(child.pid);expect(record.transaction.backup).toMatch(/^\.previous-/);
 const lease=await openSequenceReference(f.project,asset);await lease.close();expect(await readlink(join(f.project,asset.file))).toBe(await realpath(f.source));expect(await readdir(dir)).toHaveLength(2);expect(await readFile(f.source)).toEqual(wav());expect(await readFile(same)).toEqual(wav());
},20000);

it('serializes concurrent readers while recovering a dead owner',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references');await writeFile(join(dir,'.mutation-lock'),JSON.stringify(deadJournal()));
 const leases=await Promise.all([openSequenceReference(f.project,asset),openSequenceReference(f.project,asset),openSequenceReference(f.project,asset)]);for(const lease of leases){await lease.verify();await lease.close();}expect(await readdir(dir)).toHaveLength(2);
});
it('retains all recovery leaves if the old backup record is corrupt despite an owned inode',async()=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references'),leaf=join(f.project,asset.file),metadata=leaf+'.json';
 const backup='.previous-12345678-1234-4234-8234-123456789012',b=join(dir,backup),transaction={file:asset.file,backup,before:{record:ownedInode(await lstat(metadata)),link:ownedInode(await lstat(leaf))},owned:{} as {link?:{dev:number;ino:number}}};
 await rename(leaf,b);await rename(metadata,b+'.json');await symlink(await realpath(f.source),leaf);transaction.owned.link=ownedInode(await lstat(leaf));await writeFile(b+'.json','{}');
 await writeFile(join(dir,'.mutation-lock'),JSON.stringify({...deadJournal(),transaction}));const before=(await readdir(dir)).sort();
 await expect(openSequenceReference(f.project,asset)).rejects.toThrow('整合性');expect((await readdir(dir)).sort()).toEqual(before);expect(await readFile(b+'.json','utf8')).toBe('{}');expect(ownedInode(await lstat(leaf))).toEqual(transaction.owned.link);
});

it.each(['alive','EPERM'] as const)('diagnoses an unclaimed other PID (%s) without removing its marker or leaves',async state=>{
 const f=await fixture(),asset=await registerSequenceReference(f.project,f.source),dir=join(f.project,'.harness/references'),lock=join(dir,'.mutation-lock');
 const owner={...deadJournal(),pid:424242,startedAt:1700000000000},bytes=JSON.stringify(owner);await writeFile(lock,bytes);const names=(await readdir(dir)).sort(),source=await readFile(f.source);
 const original=process.kill.bind(process),kill=vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{if(pid===owner.pid){expect(signal).toBe(0);if(state==='EPERM')throw Object.assign(new Error('permission denied'),{code:'EPERM'});return true;}return original(pid,signal);});
 try{
  const status=await sequenceReferenceStatus(f.project,asset);expect(status.state).toBe('invalid');
  for(const required of ['.harness/references/.mutation-lock',String(owner.pid),String(owner.startedAt),'別のエディター','処理中','再起動','修復'])expect(status.message).toContain(required);
  expect(await readFile(lock,'utf8')).toBe(bytes);expect((await readdir(dir)).sort()).toEqual(names);expect(await readFile(f.source)).toEqual(source);
 }finally{kill.mockRestore();}
});
