import {afterEach,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {destinationsTesting,listCopyDestinations,resolveCopyDestination,type DestinationInput} from './destinations';
import {COPY_ROOT_NAME,CopyFolderError,UNKNOWN_DRIVE_REASON,ensureCopyFolder,listVolumes} from './volumes';
import {SpaceReservations} from './space';
import {COPY_REMOVABLE_NOTE} from '../../../shared/mediaCopy';
import {SimulatedCrash,WRITE_FLAGS} from './io';
import {GiB,copyWorld,type CopyWorld} from './__fixtures__/copyWorld';

let world:CopyWorld;afterEach(async()=>{destinationsTesting.volumesRoot='/Volumes';await world?.cleanup();});
/** 案件（一時フォルダーの中。.harness の中を「場所を指定」で選べないことを試す）。 */
const project=()=>({name:'案件',id:'12345678-aaaa',root:join(world.root,'case')});
/** 元の素材（中身は小さい。大きさは sizeBytes で宣言する）。 */
async function input(folder:string,names:string[],extra:Partial<DestinationInput>={}):Promise<DestinationInput>{
  const sources=await Promise.all(names.map(async name=>{const path=join(folder,name);await writeFile(path,'x');return {path,sizeBytes:30*GiB};}));
  return {project:project(),sources,...extra};
}

it('offers this Mac and writable external drives, never the source drive, a network drive or a read-only one',async()=>{
  world=await copyWorld();const views=await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations());
  expect(views.map(view=>view.key)).toEqual(['internal','volume:SSD']);
  expect(views[0]).toMatchObject({label:'このMac（ムービー）',volume:{uuid:'BOOT'},selectable:true,space:{free:300*GiB,capacity:500*GiB,after:270*GiB,margin:50*GiB}});
  expect(views[1]).toMatchObject({label:'ssd',volume:{uuid:'SSD'},space:{free:900*GiB,capacity:1000*GiB,after:870*GiB,margin:100*GiB}});
  // 画面へは表示に使うものだけを渡す（ホームを含む絶対パス・種類は渡さない）
  expect(Object.keys(views[0]!).sort()).toEqual(['key','label','selectable','space','time','volume']);
});
it('lists without creating or opening anything for writing',async()=>{
  world=await copyWorld();await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations());
  expect(world.faulty.calls.filter(call=>call.op==='mkdir'||call.op==='rename'||call.op==='unlink'||(call.op==='open'&&(call.flags!&WRITE_FLAGS)!==0))).toEqual([]);
  expect(existsSync(join(world.ssd,COPY_ROOT_NAME))).toBe(false);expect(existsSync(join(world.home,'Movies',COPY_ROOT_NAME))).toBe(false);
});
it('excludes every source drive of a batch',async()=>{
  world=await copyWorld();const a=await input(world.sd,['a.mp4']),b=await input(world.ssd,['b.mp4']);
  expect((await listCopyDestinations(world.io,{...a,sources:[...a.sources,...b.sources]},new SpaceReservations())).map(view=>view.key)).toEqual(['internal']);
});
it('excludes another volume of the same APFS container as a source (the same drive)',async()=>{
  world=await copyWorld();const other=join(world.root,'ssd2');await mkdir(other);
  world.io.volumes.push({mountPoint:other,uuid:'SSD2',kind:'external',container:'disk9',capacity:1000*GiB,free:900*GiB});
  expect((await listCopyDestinations(world.io,await input(world.ssd,['b.mp4']),new SpaceReservations())).map(view=>view.key)).toEqual(['internal','volume:SD']);
  expect((await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations())).map(view=>view.key)).toEqual(['internal','volume:SSD','volume:SSD2']);
});
it('falls back to the device number when the source volume cannot be identified',async()=>{
  world=await copyWorld();const source=await input(world.sd,['a.mp4']),file=source.sources[0]!.path,other=(await stat(world.root)).dev+1000;
  // 元のファイルが SD の取り付け先の下なのに SD と違う dev（取り外し後に残ったフォルダーなど）: UUID では決まらず、同じ dev の SSD を除く。
  const io={...world.io,stat:async(path:string)=>{const info=await world.io.stat(path);return path===file||path===world.ssd?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:other}):info;},
    lstat:async(path:string)=>{const info=await world.io.lstat(path);return path===world.ssd?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:other}):info;}};
  expect((await listCopyDestinations(io,source,new SpaceReservations())).map(view=>view.key)).toEqual(['internal','volume:SD']);
});
it('refuses to list when a source cannot be checked',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);await rm(base.sources[0]!.path);
  await expect(listCopyDestinations(world.io,base,new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('元の素材')});
});
it('shows why a drive cannot be chosen and recommends one that can',async()=>{
  world=await copyWorld();world.io.volumes.find(volume=>volume.uuid==='SSD')!.free=40*GiB;
  const views=await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations()),ssd=views.find(view=>view.key==='volume:SSD')!;
  expect(ssd.selectable).toBe(false);expect(ssd.reason).toContain('安全のための余裕（100.0 GB');
  expect(views.find(view=>view.key==='internal')).toMatchObject({selectable:true,recommended:true});expect(ssd.recommended).toBeUndefined();
});
it('recommends the selectable drive that keeps the most free space, and none when nothing can be chosen',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);
  expect((await listCopyDestinations(world.io,base,new SpaceReservations())).filter(view=>view.recommended).map(view=>view.key)).toEqual(['volume:SSD']);
  for(const volume of world.io.volumes)volume.free=10*GiB;
  expect((await listCopyDestinations(world.io,base,new SpaceReservations())).some(view=>view.recommended)).toBe(false);
});
it('subtracts copies already reserved on the same APFS container',async()=>{
  world=await copyWorld();const reservations=new SpaceReservations();reservations.reserve('apfs:disk9',850*GiB);
  expect((await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),reservations)).find(view=>view.key==='volume:SSD')).toMatchObject({space:{after:20*GiB},selectable:false});
});
it('cannot choose a drive whose free space cannot be measured, but lets a simulated crash through',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);world.faults.push({op:'statfs',path:new RegExp(`^${world.ssd}$`),nth:1,error:'EIO'});
  expect((await listCopyDestinations(world.io,base,new SpaceReservations())).find(view=>view.key==='volume:SSD')).toMatchObject({selectable:false,space:null,reason:'空き容量を測れないため選べません'});
  world.faults.push({op:'statfs',path:new RegExp(`^${world.ssd}$`),crash:true});
  await expect(listCopyDestinations(world.io,base,new SpaceReservations())).rejects.toBeInstanceOf(SimulatedCrash);
  // 場所の確認（根から1段ずつの lstat）の途中の強制終了も「選べない」に変えずに通す
  world.faults.length=0;world.faults.push({op:'lstat',path:new RegExp(`^${join(world.home,'Movies')}$`),crash:true});
  await expect(listCopyDestinations(world.io,base,new SpaceReservations())).rejects.toBeInstanceOf(SimulatedCrash);
});
it('gives the time range only when the source speed is known',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);
  expect((await listCopyDestinations(world.io,base,new SpaceReservations()))[0]!.time).toBeNull();
  expect((await listCopyDestinations(world.io,{...base,sourceBytesPerSecond:32e6},new SpaceReservations()))[0]!.time).toEqual({minSeconds:Math.ceil(30*GiB/32e6+30),maxSeconds:Math.ceil(30*GiB/32e6*3)});
});
it('cannot choose this Mac when the Movies folder is a link, missing or not a folder: the same check as when the copy starts',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),movies=join(world.home,'Movies'),boot=(await listVolumes(world.io)).find(volume=>volume.uuid==='BOOT')!;
  const internal=async()=>(await listCopyDestinations(world.io,base,new SpaceReservations())).find(view=>view.key==='internal')!;
  const starts=()=>ensureCopyFolder(world.io,boot,movies,[COPY_ROOT_NAME,'案件-12345678']);
  await rm(movies,{recursive:true});await symlink(world.ssd,movies);
  expect(await internal()).toMatchObject({selectable:false,reason:expect.stringContaining('リンク')});await expect(starts()).rejects.toBeInstanceOf(CopyFolderError);
  await rm(movies);expect(await internal()).toMatchObject({selectable:false,reason:expect.stringContaining('見つかりません')});await expect(starts()).rejects.toBeInstanceOf(CopyFolderError);
  await writeFile(movies,'x');expect(await internal()).toMatchObject({selectable:false,reason:expect.stringContaining('フォルダーでない')});await expect(starts()).rejects.toBeInstanceOf(CopyFolderError);
  expect(existsSync(join(world.ssd,COPY_ROOT_NAME))).toBe(false);
  await expect(resolveCopyDestination(world.io,base,{key:'internal',uuid:'BOOT',dev:boot.dev},new SpaceReservations())).rejects.toMatchObject({status:409});
});
it('cannot choose this Mac when the Movies folder is on another drive, nor a chosen folder on a drive it cannot identify',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),movies=join(world.home,'Movies'),mine=join(world.home,'mine'),boot=(await listVolumes(world.io)).find(volume=>volume.uuid==='BOOT')!;await mkdir(mine);
  // 偽ボリュームは dev が共通なので、ムービーと指定した場所だけ別の dev に見せる（別のドライブの取り付け先・ホームの移動）
  const other=(info:Awaited<ReturnType<typeof world.io.lstat>>)=>Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:info.dev+1000});
  const io={...world.io,lstat:async(path:string)=>{const info=await world.io.lstat(path);return path===movies||path===mine?other(info):info;}};
  const views=await listCopyDestinations(io,{...base,customPath:mine},new SpaceReservations());
  expect(views.find(view=>view.key==='internal')).toMatchObject({selectable:false,reason:UNKNOWN_DRIVE_REASON});
  expect(views.find(view=>view.key==='custom')).toMatchObject({selectable:false,reason:UNKNOWN_DRIVE_REASON});
  await expect(ensureCopyFolder(io,boot,movies,[COPY_ROOT_NAME,'案件-12345678'])).rejects.toBeInstanceOf(CopyFolderError);
});
it('cannot choose the external drives folder itself, or a leftover folder of a drive that is not connected',async()=>{
  world=await copyWorld();expect(destinationsTesting.volumesRoot).toBe('/Volumes');
  // /Volumes は内蔵と同じ dev なので、見かけの場所だけで内蔵とみなすと、取り外し後に残ったフォルダーへ（＝内蔵へ）書いてしまう
  const base=await input(world.sd,['a.mp4']),volumesRoot=join(world.root,'Volumes'),gone=join(volumesRoot,'Gone');await mkdir(gone,{recursive:true});destinationsTesting.volumesRoot=volumesRoot;
  for(const path of [volumesRoot,gone])expect((await listCopyDestinations(world.io,{...base,customPath:path},new SpaceReservations())).find(view=>view.key==='custom'))
    .toMatchObject({selectable:false,space:null,volume:{uuid:'',dev:-1},reason:UNKNOWN_DRIVE_REASON});
  await expect(resolveCopyDestination(world.io,base,{key:'custom',uuid:'BOOT',dev:(await stat(world.root)).dev,customPath:gone},new SpaceReservations())).rejects.toMatchObject({status:409});
});
it('never offers this Mac when a source is on it, and says why when it cannot be written',async()=>{
  world=await copyWorld();
  expect((await listCopyDestinations(world.io,await input(world.home,['h.mp4']),new SpaceReservations())).map(view=>view.key)).toEqual(['volume:SSD','volume:SD']);   // 取り外し可能な SD は最後
  world.io.volumes.find(volume=>volume.uuid==='BOOT')!.writable=false;
  expect((await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations())).find(view=>view.key==='internal')).toMatchObject({selectable:false,space:null,reason:'書き込めないドライブです'});
});
it('cannot choose a drive whose existing copy folder is on another drive or cannot be checked',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),folder=join(world.ssd,COPY_ROOT_NAME);await mkdir(folder);
  const ssd=async(io=world.io)=>(await listCopyDestinations(io,base,new SpaceReservations())).find(view=>view.key==='volume:SSD')!;
  const io={...world.io,lstat:async(path:string)=>{const info=await world.io.lstat(path);return path===folder?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:info.dev+1000}):info;}};
  expect(await ssd(io)).toMatchObject({selectable:false,reason:'コピー先の途中に別のドライブがあります'});
  world.faults.push({op:'lstat',path:new RegExp(`^${folder}$`),error:'EACCES'});expect(await ssd()).toMatchObject({selectable:false,reason:'コピー先のフォルダーを確かめられません'});
  world.faults.length=0;world.faults.push({op:'lstat',path:new RegExp(`^${world.ssd}$`),error:'EACCES'});expect(await ssd()).toMatchObject({selectable:false,reason:'コピー先を確かめられません'});
});
it("cannot choose any project's .harness folder or a folder in it, nor the open project's folder or a folder in it",async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),root=base.project.root,state=join(root,'.harness','references');await mkdir(state,{recursive:true});
  const otherState=join(world.ssd,'other-case','.harness','copies'),oddCase=join(world.ssd,'third','.Harness'),inside=join(root,'footage');
  for(const dir of [otherState,oddCase,inside,join(world.ssd,'.harness-old'),join(world.ssd,'my.harness')])await mkdir(dir,{recursive:true});
  const custom=async(path:string)=>(await listCopyDestinations(world.io,{...base,customPath:path},new SpaceReservations())).find(view=>view.key==='custom')!;
  // 管理用フォルダー（.harness）の段を含む場所は、どの案件のものでも（大文字小文字の違う書き方でも）選べない
  for(const path of [join(root,'.harness'),state,join(world.ssd,'other-case','.harness'),otherState,oddCase])
    expect(await custom(path),path).toMatchObject({selectable:false,space:null,reason:'案件の管理用フォルダー（.harness）の中には置けません'});
  // 開いている案件のフォルダーそのものとその中も選べない
  for(const path of [root,inside])expect(await custom(path),path).toMatchObject({selectable:false,space:null,reason:'開いている案件のフォルダーの中には置けません'});
  // 名前の一部が .harness なだけの場所・ほかの案件のフォルダーは選べる
  for(const path of [join(world.ssd,'.harness-old'),join(world.ssd,'my.harness'),join(world.ssd,'other-case')])expect(await custom(path),path).toMatchObject({selectable:true});
  await expect(resolveCopyDestination(world.io,base,{key:'custom',...(await custom(state)).volume,customPath:state},new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('.harness')});
  await expect(resolveCopyDestination(world.io,base,{key:'custom',...(await custom(inside)).volume,customPath:inside},new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('開いている案件')});
});
it('cannot choose a drive whose copy folder already has a link on the way',async()=>{
  world=await copyWorld();await symlink(world.home,join(world.ssd,COPY_ROOT_NAME));
  expect((await listCopyDestinations(world.io,await input(world.sd,['a.mp4']),new SpaceReservations())).find(view=>view.key==='volume:SSD')).toMatchObject({selectable:false,reason:expect.stringContaining('リンク')});
});
it('applies the same checks to a folder the user chose',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);
  for(const dir of [join(world.ssd,'mine'),join(world.sd,'mine'),join(world.nas,'mine'),join(world.ro,'mine')])await mkdir(dir);
  const custom=async(path:string)=>(await listCopyDestinations(world.io,{...base,customPath:path},new SpaceReservations())).find(view=>view.key==='custom')!;
  expect(await custom(join(world.ssd,'mine'))).toMatchObject({selectable:true,label:'指定した場所（mine）',volume:{uuid:'SSD'}});
  expect((await custom(join(world.sd,'mine'))).reason).toBe('元の素材と同じドライブには置けません');
  // ネットワークの場所の識別（network:<装置名>。利用者名を含みうる）は画面へ渡さない
  expect(await custom(join(world.nas,'mine'))).toMatchObject({reason:'ネットワークの場所には置けません',volume:{uuid:'',dev:-1},space:null});
  expect((await custom(join(world.ro,'mine'))).reason).toBe('書き込めないドライブです');
});
it('shows a chosen place that is missing, a link or a file as not selectable, and never touches a network place',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']);await writeFile(join(world.ssd,'file'),'x');await symlink(join(world.home,'Movies'),join(world.ssd,'link'));
  const custom=async(path:string)=>{const views=await listCopyDestinations(world.io,{...base,customPath:path},new SpaceReservations());expect(views.map(view=>view.key)).toEqual(['internal','volume:SSD','custom']);return views[2]!;};
  expect(await custom(join(world.ssd,'gone'))).toMatchObject({selectable:false,volume:{uuid:'SSD'},reason:expect.stringContaining('見つかりません')});
  expect(await custom(join(world.ssd,'file'))).toMatchObject({selectable:false,reason:expect.stringContaining('フォルダーでない')});
  expect(await custom(join(world.ssd,'link'))).toMatchObject({selectable:false,reason:expect.stringContaining('リンク')});
  expect(await custom(`${world.ssd}/../ssd`)).toMatchObject({selectable:false,reason:expect.stringContaining('不正')});
  world.faulty.calls.length=0;await custom(join(world.nas,'mine'));
  expect(world.faulty.calls.filter(call=>call.path.startsWith(world.nas))).toEqual([]);
});
it('re-checks the choice at start: the same drive identity, still selectable',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),views=await listCopyDestinations(world.io,base,new SpaceReservations()),ssd=views.find(view=>view.key==='volume:SSD')!;
  const chosen=await resolveCopyDestination(world.io,base,{key:ssd.key,...ssd.volume},new SpaceReservations());
  expect(chosen).toMatchObject({key:'volume:SSD',kind:'volume',base:world.ssd,segments:[COPY_ROOT_NAME,'案件-12345678'],margin:100*GiB});
  expect(await resolveCopyDestination(world.io,base,{key:'internal',...views[0]!.volume},new SpaceReservations())).toMatchObject({kind:'internal',label:'このMac（ムービー）',base:join(world.home,'Movies'),segments:[COPY_ROOT_NAME,'案件-12345678'],margin:50*GiB});
  await expect(resolveCopyDestination(world.io,base,{key:ssd.key,uuid:'SSD',dev:ssd.volume.dev+1},new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('入れ替わりました')});
  world.io.volumes.find(volume=>volume.uuid==='SSD')!.free=40*GiB;
  await expect(resolveCopyDestination(world.io,base,{key:ssd.key,...ssd.volume},new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('安全のための余裕')});
  await expect(resolveCopyDestination(world.io,base,{key:'volume:GONE',uuid:'GONE',dev:1},new SpaceReservations())).rejects.toMatchObject({status:409});
});
it('starts in the chosen folder itself, and refuses a chosen folder that is no longer selectable',async()=>{
  world=await copyWorld();const base=await input(world.sd,['a.mp4']),mine=join(world.ssd,'mine');await mkdir(mine);
  const view=(await listCopyDestinations(world.io,{...base,customPath:mine},new SpaceReservations())).find(item=>item.key==='custom')!;
  const request={key:'custom',...view.volume,customPath:mine},chosen=await resolveCopyDestination(world.io,base,request,new SpaceReservations());
  expect(chosen).toMatchObject({key:'custom',kind:'custom',label:'指定した場所（mine）',base:mine,segments:[],volume:{uuid:'SSD'}});
  await expect(resolveCopyDestination(world.io,base,{key:'custom',...view.volume},new SpaceReservations())).rejects.toMatchObject({status:409});   // 場所が無い
  await rm(mine,{recursive:true});await expect(resolveCopyDestination(world.io,base,request,new SpaceReservations())).rejects.toMatchObject({status:409,message:expect.stringContaining('見つかりません')});
});
// 取り外し可能な媒体（diskutil の Removable Media: Removable。SD カード）は書き込みが遅いことがある: 候補の最後に回し、注記を添え、勧めない（2026-10-08 承認）。
it('puts a removable card after the other drives with a note, and does not recommend it even when it keeps the most space',async()=>{
  world=await copyWorld();const sd=world.io.volumes.find(volume=>volume.uuid==='SD')!;sd.capacity=2000*GiB;sd.free=1900*GiB;
  const other=join(world.root,'ssd2');await mkdir(other);world.io.volumes.push({mountPoint:other,uuid:'SSD2',kind:'external',container:'disk8',capacity:1000*GiB,free:900*GiB});
  const views=await listCopyDestinations(world.io,await input(world.ssd,['b.mp4']),new SpaceReservations());
  expect(views.map(view=>view.key)).toEqual(['internal','volume:SSD2','volume:SD']);
  expect(views[2]).toMatchObject({selectable:true,note:COPY_REMOVABLE_NOTE});expect(views[2]!.recommended).toBeUndefined();
  expect(views.filter(view=>view.recommended).map(view=>view.key)).toEqual(['volume:SSD2']);
  expect(views.filter(view=>view.note).map(view=>view.key)).toEqual(['volume:SD']);
  expect(COPY_REMOVABLE_NOTE).toBe('SD カードは書き込みが遅いことがあります');
});
it('recommends nothing when only a removable card can be chosen, and keeps it selectable',async()=>{
  world=await copyWorld();world.io.volumes.find(volume=>volume.uuid==='BOOT')!.free=10*GiB;world.io.volumes.find(volume=>volume.uuid==='SD')!.free=60*GiB;
  const views=await listCopyDestinations(world.io,await input(world.ssd,['b.mp4']),new SpaceReservations());
  expect(views.find(view=>view.key==='internal')!.selectable).toBe(false);
  expect(views.find(view=>view.key==='volume:SD')).toMatchObject({selectable:true,note:COPY_REMOVABLE_NOTE});
  expect(views.some(view=>view.recommended)).toBe(false);
});
it('adds the note to a chosen folder on a removable card',async()=>{
  world=await copyWorld();world.io.volumes.find(volume=>volume.uuid==='SD')!.free=60*GiB;const mine=join(world.sd,'mine');await mkdir(mine);
  const views=await listCopyDestinations(world.io,await input(world.ssd,['b.mp4'],{customPath:mine}),new SpaceReservations());
  expect(views.find(view=>view.key==='custom')).toMatchObject({selectable:true,note:COPY_REMOVABLE_NOTE});
});
