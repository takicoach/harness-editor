import {afterEach,expect,it,vi} from 'vitest';
import {mkdir,mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const calls=vi.hoisted(()=>[] as string[]);
vi.mock('./sharedDigest',async load=>{const actual=await load<typeof import('./sharedDigest')>();
  // 50ms 遅らせて本物へ渡す: 小さい試料でも、先の照合が終わる前に3つの呼び手が全員ここへ来る（記憶済みで素通りしない）。
  return {...actual,sharedFileDigest:async(path:string,identity:string,signal?:AbortSignal)=>{calls.push(JSON.stringify([path,identity]));await new Promise(resolve=>setTimeout(resolve,50));return actual.sharedFileDigest(path,identity,signal);}};});
import {importSequenceAsset,openSequenceAsset,verifiedSequenceAssetPath} from './assets';
import {openSequenceReference,referenceVerificationTesting,registerSequenceReference} from './references';
const roots:string[]=[];afterEach(async()=>{calls.length=0;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function wav(){const samples=4000,b=Buffer.alloc(44+samples*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;}
it('managed assets: concurrent path checks and pinned reads wait on one shared digest of the same file identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'harness-asset-digest-'));roots.push(root);const source=join(root,'in.wav');await writeFile(source,wav());
  const asset=await importSequenceAsset(root,source,'in.wav');
  const later=new Date(Date.now()+5000);await utimes(join(root,asset.file),later,later);calls.length=0;   // 記憶済みの照合を外す
  const leases=await Promise.all([verifiedSequenceAssetPath(root,asset),verifiedSequenceAssetPath(root,asset),openSequenceAsset(root,asset)]);
  await (leases[2] as Awaited<ReturnType<typeof openSequenceAsset>>).close();
  expect(calls).toHaveLength(3);expect(new Set(calls).size).toBe(1);
},30000);
it('references: concurrent opens join one background check (one shared digest)',async()=>{
  const root=await mkdtemp(join(tmpdir(),'harness-reference-digest-'));roots.push(root);const project=join(root,'project'),source=join(root,'source.wav');
  await mkdir(project);await writeFile(source,wav());
  const asset=await registerSequenceReference(project,source);
  const later=new Date(Date.now()+5000);await utimes(source,later,later);calls.length=0;const joined=referenceVerificationTesting.joined;
  const leases=await Promise.all([openSequenceReference(project,asset),openSequenceReference(project,asset)]);for(const lease of leases)await lease.close();
  // 照合は組ごとに裏の作業1本。2つ目の呼び手はその作業に合流する。
  expect(calls).toHaveLength(1);expect(referenceVerificationTesting.joined-joined).toBe(1);
},30000);
