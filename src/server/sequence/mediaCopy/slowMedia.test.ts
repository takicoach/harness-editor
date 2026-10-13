// 開いた時の案内（設計 §1・§2）と「この接続先では今後出さない」の記録（.harness/slow-media.json）。
import {afterEach,expect,it} from 'vitest';
import {link,lstat,mkdir,readFile,readdir,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import type {ReferenceReadState} from '../references';
import {SLOW_MEDIA_MAX_BYTES,connectionOf,isSlowAdviceSuppressed,readSlowMediaPrefs,slowMediaAdvice,suppressSlowMediaAdvice} from './slowMedia';
import {listVolumes} from './volumes';
import {MiB,copyWorld,type CopyWorld} from './__fixtures__/copyWorld';

let world:CopyWorld;afterEach(async()=>{await world?.cleanup();});
const asset=(letter:string,name=`${letter}.mp4`):SequenceAsset=>({id:`media-${letter.repeat(24)}`,kind:'media',name,file:`.harness/references/${letter.repeat(64)}.mp4`,fingerprint:letter.repeat(64),streams:[]});
async function project(){const root=join(world.home,'case');await mkdir(join(root,'.harness'),{recursive:true});return root;}
const record=(root:string)=>join(root,'.harness/slow-media.json');
const ports=(states:Map<string,ReferenceReadState>)=>({readState:async(_root:string,item:SequenceAsset)=>states.get(item.id)});

it('keeps "do not show again" per asset and connection, and ignores a broken record',async()=>{
  world=await copyWorld();const root=await project(),connection={target:join(world.sd,'a.mp4'),volume:'SD'};
  expect(await readSlowMediaPrefs(root)).toEqual({});
  await suppressSlowMediaAdvice(root,asset('a').id,connection);
  expect(await readSlowMediaPrefs(root)).toEqual({[asset('a').id]:connection});
  expect(((await stat(record(root))).mode&0o777)).toBe(0o600);
  expect(isSlowAdviceSuppressed(await readSlowMediaPrefs(root),asset('a').id,connection)).toBe(true);
  expect(isSlowAdviceSuppressed(await readSlowMediaPrefs(root),asset('a').id,{...connection,volume:'OTHER'})).toBe(false);
  expect(isSlowAdviceSuppressed(await readSlowMediaPrefs(root),asset('b').id,connection)).toBe(false);
  await writeFile(record(root),'{broken');expect(await readSlowMediaPrefs(root)).toEqual({});
  // 形が違う（知らない項目・素材 ID でない鍵・相対パス）記録も無いものとする（案内を出す側に倒す）。
  for(const value of [{format:'harness-slow-media',version:1,entries:{[asset('a').id]:{...connection,extra:1}}},{format:'harness-slow-media',version:1,entries:{'../x':connection}},
    {format:'harness-slow-media',version:1,entries:{[asset('a').id]:{...connection,target:'a.mp4'}}},{format:'harness-slow-media',version:2,entries:{}}]){
    await writeFile(record(root),JSON.stringify(value));expect(await readSlowMediaPrefs(root)).toEqual({});
  }
  // 壊れた記録の上に書くと、新しい記録だけになる。
  await suppressSlowMediaAdvice(root,asset('b').id,connection);expect(await readSlowMediaPrefs(root)).toEqual({[asset('b').id]:connection});
});
it('ignores a record larger than the limit',async()=>{
  world=await copyWorld();const root=await project(),connection={target:join(world.sd,'a.mp4'),volume:'SD'};
  const value=JSON.stringify({format:'harness-slow-media',version:1,entries:{[asset('a').id]:connection}});
  await writeFile(record(root),value+' '.repeat(SLOW_MEDIA_MAX_BYTES));expect(await readSlowMediaPrefs(root)).toEqual({});
  await writeFile(record(root),value);expect(await readSlowMediaPrefs(root)).toEqual({[asset('a').id]:connection});
});
it('refuses to write through a linked .harness folder',async()=>{
  world=await copyWorld();const root=join(world.home,'linked');await mkdir(root);await symlink(world.ssd,join(root,'.harness'));
  await expect(suppressSlowMediaAdvice(root,asset('a').id,{target:'/x',volume:'SD'})).rejects.toThrow('記録先が不正');
  expect(await readdir(world.ssd)).toEqual([]);expect(await readSlowMediaPrefs(root)).toEqual({});
  // .harness が無い案件には作らない（削除された案件のフォルダーを復活させない）。
  const bare=join(world.home,'bare');await mkdir(bare);
  await expect(suppressSlowMediaAdvice(bare,asset('a').id,{target:'/x',volume:'SD'})).rejects.toThrow();expect(await readdir(bare)).toEqual([]);
});
it('does not read or write through a linked record, and replaces the link instead',async()=>{
  world=await copyWorld();const root=await project(),outside=join(world.ssd,'outside.json'),connection={target:join(world.sd,'a.mp4'),volume:'SD'};
  const planted=JSON.stringify({format:'harness-slow-media',version:1,entries:{[asset('a').id]:connection}});
  await writeFile(outside,planted);await symlink(outside,record(root));
  expect(await readSlowMediaPrefs(root)).toEqual({});
  await suppressSlowMediaAdvice(root,asset('b').id,connection);
  expect(await readFile(outside,'utf8')).toBe(planted);expect((await lstat(record(root))).isSymbolicLink()).toBe(false);
  expect(await readSlowMediaPrefs(root)).toEqual({[asset('b').id]:connection});
});
it('does not change the outside file when the record is a hard link to it',async()=>{
  world=await copyWorld();const root=await project(),outside=join(world.ssd,'outside.json'),connection={target:join(world.sd,'a.mp4'),volume:'SD'};
  const planted=JSON.stringify({format:'harness-slow-media',version:1,entries:{[asset('a').id]:connection}});
  await writeFile(outside,planted);await link(outside,record(root));expect((await stat(outside)).nlink).toBe(2);
  await suppressSlowMediaAdvice(root,asset('b').id,connection);
  expect(await readFile(outside,'utf8')).toBe(planted);expect((await stat(outside)).nlink).toBe(1);expect((await stat(record(root))).nlink).toBe(1);
  expect(Object.keys(await readSlowMediaPrefs(root))).toEqual([asset('a').id,asset('b').id]);
});
it('clears its own temporary files left for more than an hour, and nothing else',async()=>{
  world=await copyWorld();const root=await project(),harness=join(root,'.harness'),hoursAgo=new Date(Date.now()-2*60*60*1000);
  const stale=`slow-media.json.${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}.tmp`,fresh=`slow-media.json.${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}.tmp`;
  const folderLike=`slow-media.json.${'3'.repeat(8)}-3333-4333-8333-${'3'.repeat(12)}.tmp`,others=['imp-0123456789abcdef0123.tmp','slow-media.json.tmp','notes.txt'];
  for(const name of [stale,fresh,...others])await writeFile(join(harness,name),'x');await mkdir(join(harness,folderLike));
  for(const name of [stale,folderLike,...others])await utimes(join(harness,name),hoursAgo,hoursAgo);
  await suppressSlowMediaAdvice(root,asset('a').id,{target:'/x',volume:'SD'});
  expect((await readdir(harness)).sort()).toEqual([fresh,folderLike,...others,'slow-media.json'].sort());
});
it('leaves no temporary file behind when the record cannot be replaced',async()=>{
  world=await copyWorld();const root=await project();await mkdir(record(root));
  await expect(suppressSlowMediaAdvice(root,asset('a').id,{target:'/x',volume:'SD'})).rejects.toThrow();
  expect(await readdir(join(root,'.harness'))).toEqual(['slow-media.json']);
});
it('does not lose a record when several are written at the same time',async()=>{
  world=await copyWorld();const root=await project(),letters='0123456789abcdef'.split(''),connection=(letter:string)=>({target:join(world.sd,`${letter}.mp4`),volume:'SD'});
  await Promise.all(letters.map(letter=>suppressSlowMediaAdvice(root,asset(letter).id,connection(letter))));
  expect(await readSlowMediaPrefs(root)).toEqual(Object.fromEntries(letters.map(letter=>[asset(letter).id,connection(letter)])));
  expect((await readdir(join(root,'.harness'))).filter(name=>name.endsWith('.tmp'))).toEqual([]);
});
it('drops the oldest records to stay within the limit, keeping the newest',async()=>{
  world=await copyWorld();const root=await project(),long=(n:number)=>({target:`/Volumes/SD/${String(n).padStart(4,'0')}${'x'.repeat(3000)}.mp4`,volume:'SD'});
  const id=(n:number)=>`media-${n.toString(16).padStart(24,'0')}`,entries:Record<string,unknown>={},body=()=>JSON.stringify({format:'harness-slow-media',version:1,entries})+'\n';
  // 上限ちょうどまで詰める（同じ大きさの項目をもう1つ足すと上限を超える）。
  let count=0;for(;;count++){entries[id(count)]=long(count);if(Buffer.byteLength(body())>SLOW_MEDIA_MAX_BYTES){delete entries[id(count)];break;}}
  await writeFile(record(root),body());expect(Object.keys(await readSlowMediaPrefs(root))).toHaveLength(count);
  await suppressSlowMediaAdvice(root,id(count+1),long(count+1));
  const prefs=await readSlowMediaPrefs(root),keys=Object.keys(prefs);
  expect((await stat(record(root))).size).toBeLessThanOrEqual(SLOW_MEDIA_MAX_BYTES);
  expect(prefs[id(count+1)]).toEqual(long(count+1));expect(keys).not.toContain(id(0));expect(keys).toContain(id(count-1));expect(keys).toHaveLength(count);
});
it('keeps the network id (it can contain the user name) out of the record and still matches it',async()=>{
  world=await copyWorld();const root=await project(),path=join(world.nas,'a.mp4');await writeFile(path,'x');
  const connection=await connectionOf(world.io,path);expect(connection).toEqual({target:path,volume:'network:/dev/fake-NAS'});
  await suppressSlowMediaAdvice(root,asset('a').id,connection!);
  expect(await readFile(record(root),'utf8')).not.toContain('fake-NAS');
  expect(isSlowAdviceSuppressed(await readSlowMediaPrefs(root),asset('a').id,connection!)).toBe(true);
  expect(isSlowAdviceSuppressed(await readSlowMediaPrefs(root),asset('a').id,{...connection!,volume:'network:/dev/other'})).toBe(false);
  const state:ReferenceReadState={path,sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB};
  expect((await slowMediaAdvice(world.io,root,[asset('a')],{readState:async()=>state})).targets).toEqual([]);
});
it('names the connection by the real path and the volume id, and nothing for a file it cannot find',async()=>{
  world=await copyWorld();const path=join(world.sd,'a.mp4'),link=join(world.home,'a-link.mp4');await writeFile(path,'x');await symlink(path,link);
  expect(await connectionOf(world.io,link)).toEqual({target:path,volume:'SD'});
  expect(await connectionOf(world.io,join(world.sd,'missing.mp4'))).toBeUndefined();
});
it('advises only unverified links on external drives that take 60 s or more, totals them, and counts the unmeasured',async()=>{
  world=await copyWorld();const root=await project(),states=new Map<string,ReferenceReadState>([
    [asset('a').id,{path:join(world.sd,'a.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}],        // 100 秒 → 案内する
    [asset('b').id,{path:join(world.sd,'b.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:10*MiB}],     // 10 秒 → 出さない
    [asset('c').id,{path:join(world.sd,'c.mp4'),sizeBytes:100*MiB,verified:false}],                           // まだ測れていない
    [asset('d').id,{path:join(world.sd,'d.mp4'),sizeBytes:100*MiB,verified:true,bytesPerSecond:MiB}],          // 照合済み → 出さない
    [asset('e').id,{path:join(world.home,'e.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}],      // このMac → 出さない
    [asset('1').id,{path:join(world.sd,'1.mp4'),sizeBytes:100*MiB,verified:false,failed:true,bytesPerSecond:MiB}],   // 照合の失敗 → エラーのバナーが扱う
    [asset('2').id,{path:join(world.sd,'2.mp4'),sizeBytes:100*MiB,verified:false,failed:true}],                     // 照合の失敗 → 未測定にも数えない
    [asset('3').id,{path:join(world.nas,'3.mp4'),sizeBytes:50*MiB,verified:false,bytesPerSecond:MiB/2}]]);          // ネットワークのドライブも外付け → 案内する
  for(const state of states.values())await writeFile(state.path,'x');
  const assets=['a','b','c','d','e','f','1','2','3'].map(letter=>asset(letter)).concat([{...asset('g'),file:'.harness/assets/x.mp4'}]);
  const advice=await slowMediaAdvice(world.io,root,assets,ports(states));
  expect(advice).toEqual({targets:[{assetId:asset('a').id,name:'a.mp4',sizeBytes:100*MiB,seconds:100},{assetId:asset('3').id,name:'3.mp4',sizeBytes:50*MiB,seconds:100}],
    totalBytes:150*MiB,totalSeconds:200,unmeasured:1});
});
// 申し送り（Task 12 → 15）: このエディターがコピーしている素材は、案内にも「まだ測れていない数」にも入れない（コピーが終われば照合済みになる）。
it('leaves out the links this editor is copying, from the targets and from the unmeasured count',async()=>{
  world=await copyWorld();const root=await project(),states=new Map<string,ReferenceReadState>([
    [asset('a').id,{path:join(world.sd,'a.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}],                 // 案内する
    [asset('b').id,{path:join(world.sd,'b.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB,copying:true}],    // コピー中 → 出さない
    [asset('c').id,{path:join(world.sd,'c.mp4'),sizeBytes:100*MiB,verified:false,copying:true}],                       // コピー中 → 未測定にも数えない
    [asset('d').id,{path:join(world.sd,'d.mp4'),sizeBytes:100*MiB,verified:false}]]);                                  // まだ測れていない
  for(const state of states.values())await writeFile(state.path,'x');
  expect(await slowMediaAdvice(world.io,root,['a','b','c','d'].map(letter=>asset(letter)),ports(states))).toEqual({
    targets:[{assetId:asset('a').id,name:'a.mp4',sizeBytes:100*MiB,seconds:100}],totalBytes:100*MiB,totalSeconds:100,unmeasured:1});
});
it('rounds the seconds up and advises from exactly 60 s',async()=>{
  world=await copyWorld();const root=await project(),states=new Map<string,ReferenceReadState>([
    [asset('a').id,{path:join(world.sd,'a.mp4'),sizeBytes:60*MiB,verified:false,bytesPerSecond:MiB}],
    [asset('b').id,{path:join(world.sd,'b.mp4'),sizeBytes:60*MiB-1,verified:false,bytesPerSecond:MiB}],
    [asset('c').id,{path:join(world.sd,'c.mp4'),sizeBytes:61*MiB+1,verified:false,bytesPerSecond:MiB}]]);
  for(const state of states.values())await writeFile(state.path,'x');
  const advice=await slowMediaAdvice(world.io,root,['a','b','c'].map(letter=>asset(letter)),ports(states));
  expect(advice.targets.map(target=>[target.name,target.seconds])).toEqual([['a.mp4',60],['c.mp4',62]]);expect(advice.totalSeconds).toBe(122);
});
it('does not ask the drives at all when every link is checked, and asks only mount when they are all on this Mac',async()=>{
  world=await copyWorld();const root=await project(),states=new Map<string,ReferenceReadState>([
    [asset('a').id,{path:join(world.sd,'a.mp4'),sizeBytes:100*MiB,verified:true,bytesPerSecond:MiB}],
    [asset('b').id,{path:join(world.sd,'b.mp4'),sizeBytes:100*MiB,verified:false,failed:true,bytesPerSecond:MiB}]]);
  const empty={targets:[],totalBytes:0,totalSeconds:0,unmeasured:0},drives=()=>world.faulty.calls.filter(call=>call.op==='mounts'||call.op==='volumeDetails').map(call=>call.op);
  expect(await slowMediaAdvice(world.io,root,[asset('a'),asset('b')],ports(states))).toEqual(empty);expect(drives()).toEqual([]);
  states.set(asset('c').id,{path:join(world.home,'c.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB});await writeFile(join(world.home,'c.mp4'),'x');
  expect(await slowMediaAdvice(world.io,root,[asset('a'),asset('c')],ports(states))).toEqual(empty);expect(drives()).toEqual(['mounts']);
});
it('does not advise an asset suppressed for this connection, and advises it again when the connection changes',async()=>{
  world=await copyWorld();const root=await project(),path=join(world.sd,'a.mp4');await writeFile(path,'x');
  let state:ReferenceReadState={path,sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB};const statePorts={readState:async()=>state};
  await suppressSlowMediaAdvice(root,asset('a').id,{target:path,volume:'SD'});
  expect(await slowMediaAdvice(world.io,root,[asset('a')],statePorts)).toEqual({targets:[],totalBytes:0,totalSeconds:0,unmeasured:0});
  // まだ測れていなくても、今後出さないと決めた接続先なら未測定にも数えない。
  state={path,sizeBytes:100*MiB,verified:false};
  expect((await slowMediaAdvice(world.io,root,[asset('a')],statePorts)).unmeasured).toBe(0);
  state={...state,bytesPerSecond:MiB};
  // 別のファイルへつなぎ直した（パスが変わった）
  const moved=join(world.sd,'moved.mp4');await writeFile(moved,'x');state={...state,path:moved};
  expect((await slowMediaAdvice(world.io,root,[asset('a')],statePorts)).targets).toHaveLength(1);
  // 同じ場所でも別のドライブ（同じ名前の別のカード: UUID が違う）
  state={...state,path};await suppressSlowMediaAdvice(root,asset('a').id,{target:path,volume:'OTHER-CARD'});
  expect((await slowMediaAdvice(world.io,root,[asset('a')],statePorts)).targets).toHaveLength(1);
  expect(JSON.parse(await readFile(record(root),'utf8')).format).toBe('harness-slow-media');
});
it('reads the id of only the drives that hold a candidate, once per 30 s, and never lends it to the safety checks',async()=>{
  world=await copyWorld();const root=await project(),path=join(world.sd,'a.mp4');await writeFile(path,'x');
  const states=new Map<string,ReferenceReadState>([[asset('a').id,{path,sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}]]);
  const asked=()=>world.faulty.calls.filter(call=>call.op==='volumeDetails').map(call=>call.path),mounts=()=>world.faulty.calls.filter(call=>call.op==='mounts').length;
  await suppressSlowMediaAdvice(root,asset('a').id,{target:path,volume:'SD'});
  for(let n=1;n<=2;n++){expect((await slowMediaAdvice(world.io,root,[asset('a')],ports(states))).targets).toEqual([]);expect(mounts()).toBe(n);}
  expect(asked()).toEqual([world.sd]);   // 2回の判定で1回だけ・候補の無いドライブ（このMac・SSD・読み取り専用）には聞かない
  // 同じ名前の別のカードに替わった（取り付け先・dev は同じで UUID だけ違う）。案内は 30 秒の間は覚えた識別を使う。
  world.io.volumes.find(volume=>volume.uuid==='SD')!.uuid='SD-2';
  world.clock.advance(29_999);expect((await slowMediaAdvice(world.io,root,[asset('a')],ports(states))).targets).toEqual([]);expect(asked()).toEqual([world.sd]);
  // 安全確認（コピーの開始時の照合・記録する接続先）は覚えた値を使わず毎回読み直す。
  expect((await listVolumes(world.io)).find(volume=>volume.mountPoint===world.sd)?.uuid).toBe('SD-2');
  expect(await connectionOf(world.io,path)).toEqual({target:path,volume:'SD-2'});
  // 30 秒たてば読み直す: 今後出さないとしたのは前のカードなので、また案内する。
  world.clock.advance(1);const before=asked().length;
  expect((await slowMediaAdvice(world.io,root,[asset('a')],ports(states))).targets).toHaveLength(1);expect(asked().length).toBe(before+1);
});
it('keeps an external link whose drive id cannot be read in the advice, marked as not rememberable',async()=>{
  world=await copyWorld();const root=await project(),states=new Map<string,ReferenceReadState>([
    [asset('a').id,{path:join(world.sd,'a.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}],
    [asset('b').id,{path:join(world.sd,'b.mp4'),sizeBytes:100*MiB,verified:false}],
    [asset('c').id,{path:join(world.ssd,'c.mp4'),sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}]]);
  for(const state of states.values())await writeFile(state.path,'x');
  world.faults.push({op:'volumeDetails',path:new RegExp(`^${world.sd}$`),error:'EIO'});   // diskutil が SD の識別を返さない
  // 識別を読めないドライブの素材は「今後出さない」を記録できない（記録があっても照らせない）。
  await suppressSlowMediaAdvice(root,asset('a').id,{target:join(world.sd,'a.mp4'),volume:'SD'});
  expect(await slowMediaAdvice(world.io,root,['a','b','c'].map(letter=>asset(letter)),ports(states))).toEqual({targets:[
    {assetId:asset('a').id,name:'a.mp4',sizeBytes:100*MiB,seconds:100,canRemember:false},{assetId:asset('c').id,name:'c.mp4',sizeBytes:100*MiB,seconds:100}],
    totalBytes:200*MiB,totalSeconds:200,unmeasured:1});
});
it('does not take a leftover folder under /Volumes (another device than the drive) as the drive',async()=>{
  world=await copyWorld();const root=await project(),path=join(world.sd,'a.mp4');await writeFile(path,'x');
  const states=new Map<string,ReferenceReadState>([[asset('a').id,{path,sizeBytes:100*MiB,verified:false,bytesPerSecond:MiB}]]);
  // 偽ボリュームはどれも同じ dev なので、取り付け先の dev だけを違えて取り外し後に残ったフォルダーを再現する。
  const io={...world.io,stat:async(target:string)=>{const info=await world.io.stat(target);return target===world.sd?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:info.dev+1}):info;}};
  expect(await slowMediaAdvice(io,root,[asset('a')],ports(states))).toEqual({targets:[],totalBytes:0,totalSeconds:0,unmeasured:0});
  expect(world.faulty.calls.filter(call=>call.op==='volumeDetails')).toEqual([]);
});
