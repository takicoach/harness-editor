// 使い捨ての exFAT イメージで macOS の実際の挙動を確かめる（重い任意実行: HARNESS_TEST_EXFAT=1。実在の SD カードは使わない）。
// mount・diskutil は自分が付けたイメージだけを対象にする（ownImagesIo）。イメージの置き場所は tmpdir()（実行時に TMPDIR で一時フォルダーへ向ける）。
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,stat,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CREATE_EXCLUSIVE,nodeCopyIo,runCommand} from './io';
import {COPY_ROOT_NAME,CopyFolderError,ensureCopyFolder,listVolumes} from './volumes';
import {attachImage,attachedOwnImages,createExfatImage,destroyExfatImage,detachImage,detachLeftoverImages,ownImagesInInfo,ownImagesIo,type ExfatImage} from './__fixtures__/exfatImage';

const enabled=process.env.HARNESS_TEST_EXFAT==='1'&&process.platform==='darwin';
/** 時刻の分解能を測る値: exFAT で表せる範囲（1980〜2107年）の奇数秒＋端数。1970年の値では範囲への丸めを測ってしまう。 */
const PROBE_TIME='2026-01-01T00:00:01.234567Z',PROBE_SECONDS=Date.UTC(2026,0,1,0,0,1)/1000+0.234567;
// 後片付けの照合（既定の試験でも走る）: 一時フォルダーの自分のイメージだけを拾い、ほかのイメージ（利用者の .dmg など）は拾わない。
it('picks only its own images under the temporary folder from hdiutil info',()=>{
  const entity=(dev:string,mount?:string)=>({'dev-entry':dev,...(mount?{'mount-point':mount}:{})});
  const info={images:[
    {'image-path':'/tmp/x/harness-exfat-ab12/HTX1A2B.dmg','system-entities':[entity('/dev/disk6'),entity('/dev/disk6s1','/Volumes/HTX1A2B')]},
    {'image-path':'/Users/x/Downloads/App.dmg','system-entities':[entity('/dev/disk8'),entity('/dev/disk8s1','/Volumes/App')]},
    {'image-path':'/other/harness-exfat-cd34/HTX3C4D.dmg','system-entities':[entity('/dev/disk9')]},
    {'image-path':'/tmp/x/harness-exfat-ef56/notes.dmg','system-entities':[entity('/dev/disk10')]},
    {'image-path':'/tmp/x/harness-exfat-gh78/HTX5E6F.dmg','system-entities':[entity('/dev/disk11s1','/Volumes/HTX5E6F')]},
    'garbage',null]};
  expect(ownImagesInInfo(info,'/tmp/x')).toEqual([{imagePath:'/tmp/x/harness-exfat-ab12/HTX1A2B.dmg',device:'/dev/disk6'}]);
  expect(ownImagesInInfo({},'/tmp/x')).toEqual([]);expect(ownImagesInInfo(null,'/tmp/x')).toEqual([]);
});
describe.skipIf(!enabled)('exFAT disk image (real macOS behaviour)',()=>{
  const io=ownImagesIo(nodeCopyIo);let a:ExfatImage|undefined,b:ExfatImage|undefined;const notes:Record<string,unknown>={};
  beforeAll(async()=>{a=await createExfatImage();b=await createExfatImage();},120_000);
  afterAll(async()=>{
    // 外し忘れ（attach が時間切れになった後に付いたものなど）も、一時フォルダーの自分のイメージを hdiutil info から探して外す。
    const results=await Promise.allSettled([a,b].map(image=>image?destroyExfatImage(image):undefined)),sweep=await Promise.allSettled([detachLeftoverImages()]);
    notes.leftovers=sweep[0]?.status==='fulfilled'?sweep[0].value:String(sweep[0]?.reason);console.log('[exfat-probe]',JSON.stringify(notes));
    const failed=[...results,...sweep].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  },60_000);
  it('lists the image as a local writable external exFAT volume with a VolumeUUID',async()=>{
    const volume=(await listVolumes(io)).find(item=>item.mountPoint===a!.mountPoint);
    // 後片付けの照合が本物の hdiutil info でも自分のイメージを拾えること（拾えなければ外し忘れを探せない）。
    expect((await attachedOwnImages()).map(image=>image.imagePath)).toEqual(expect.arrayContaining([a!.dmg,b!.dmg]));
    notes.details=await io.volumeDetails(a!.mountPoint);notes.mount=(await io.mounts()).find(item=>item.mountPoint===a!.mountPoint);notes.volume=volume;
    // 記録用の生の値（自分のイメージの行・項目だけ）: mount の旗の全体と、diskutil の識別まわりの項目。
    notes.mountLine=(await runCommand('/sbin/mount',[])).stdout.split('\n').find(line=>line.includes(` on ${a!.mountPoint} (`));
    const plist=(await runCommand('/usr/sbin/diskutil',['info','-plist',a!.mountPoint])).stdout,raw=JSON.parse((await runCommand('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:plist})).stdout) as Record<string,unknown>;
    notes.diskutil=Object.fromEntries(['VolumeUUID','DiskUUID','APFSContainerReference','WritableVolume','FilesystemType','FilesystemName','DeviceNode','Internal','RemovableMedia','Ejectable','BusProtocol'].map(key=>[key,raw[key]??null]));
    expect(volume).toMatchObject({kind:'external',fsType:'exfat',network:false,writable:true});
    expect(volume!.uuid).toMatch(/^[0-9A-F-]{36}$/i);expect(volume!.spaceUnit).toBe(`volume:${volume!.uuid}`);
  });
  it('gives two images different identities',async()=>{
    const list=await listVolumes(io),uuidA=list.find(item=>item.mountPoint===a!.mountPoint)!.uuid,uuidB=list.find(item=>item.mountPoint===b!.mountPoint)!.uuid;
    notes.uuids=[uuidA,uuidB];expect(uuidA).not.toBe(uuidB);
  });
  it('keeps the UUID across detach and attach; records dev, ino (file and folder) and the time resolution',async()=>{
    const file=join(a!.mountPoint,'probe.bin'),folder=join(a!.mountPoint,COPY_ROOT_NAME);await writeFile(file,'x');await mkdir(folder);await utimes(file,PROBE_SECONDS,PROBE_SECONDS);
    const before=await stat(file),folderBefore=await stat(folder),uuid=(await io.volumeDetails(a!.mountPoint)).uuid;
    await detachImage(a!.mountPoint);const detached=existsSync(a!.mountPoint);a!.mountPoint=await attachImage(a!.dmg);
    const after=await stat(join(a!.mountPoint,'probe.bin')),folderAfter=await stat(join(a!.mountPoint,COPY_ROOT_NAME)),uuidAfter=(await io.volumeDetails(a!.mountPoint)).uuid;
    Object.assign(notes,{uuidBefore:uuid,uuidAfter,mountPointAfter:a!.mountPoint,mountPointLeftAfterDetach:detached,devBefore:before.dev,devAfter:after.dev,inoBefore:before.ino,inoAfter:after.ino,
      folderDevBefore:folderBefore.dev,folderDevAfter:folderAfter.dev,folderInoBefore:folderBefore.ino,folderInoAfter:folderAfter.ino,
      timeWritten:PROBE_TIME,mtimeMsWritten:PROBE_SECONDS*1000,mtimeMsCached:before.mtimeMs,mtimeMsRead:after.mtimeMs,atimeMsRead:after.atimeMs,ctimeMs:after.ctimeMs,birthtimeMs:after.birthtimeMs});
    expect(uuidAfter).toBe(uuid);
  },60_000);
  it('treats names case-insensitively: an exclusive create sees the other case',async()=>{
    const first=await nodeCopyIo.open(join(a!.mountPoint,'CLIP.MP4'),CREATE_EXCLUSIVE,0o644);await first.close();
    const second=await nodeCopyIo.open(join(a!.mountPoint,'clip.mp4'),CREATE_EXCLUSIVE,0o644).then(async file=>{await file.close();return 'created';},(error:NodeJS.ErrnoException)=>error.code);
    notes.caseClash=second;expect(second).toBe('EEXIST');
  });
  it('creates the copy folder one level at a time and never recreates a detached volume',async()=>{
    const volume=(await listVolumes(io)).find(item=>item.mountPoint===b!.mountPoint)!;
    expect((await ensureCopyFolder(io,volume,b!.mountPoint,[COPY_ROOT_NAME,'案件-12345678'])).dev).toBe(volume.dev);
    await detachImage(b!.mountPoint);
    await expect(ensureCopyFolder(io,volume,b!.mountPoint,[COPY_ROOT_NAME,'案件-12345678'])).rejects.toBeInstanceOf(CopyFolderError);
    expect(existsSync(b!.mountPoint)).toBe(false);b!.mountPoint=await attachImage(b!.dmg);
  },60_000);
  // 同じ順で付け直すと空いた同じディスク番号に戻るので dev が変わらないように見える。逆の順で付け直し、dev がドライブではなく番号に付くことを確かめる。
  it('ties dev to the disk slot, not the drive: attached in the other order, the UUID stays and the dev may move to the other image',async()=>{
    // フォルダー（a は 3件目、b は 5件目で作った「Harness 素材」）の ino も見る: 回収（Task 11）は番号の変わった付け直しの後にも ino を照合する。
    const look=async()=>{const list=await listVolumes(io),mounts=await io.mounts(),one=async(image:ExfatImage)=>{const volume=list.find(item=>item.mountPoint===image.mountPoint)!;
      return {uuid:volume.uuid,dev:volume.dev,device:mounts.find(item=>item.mountPoint===image.mountPoint)!.device,folderIno:(await stat(join(image.mountPoint,COPY_ROOT_NAME))).ino};};return {a:await one(a!),b:await one(b!)};};
    const before=await look();await detachImage(a!.mountPoint);await detachImage(b!.mountPoint);b!.mountPoint=await attachImage(b!.dmg);a!.mountPoint=await attachImage(a!.dmg);
    const after=await look();notes.reorder={before,after,bTookOldDevOfA:after.b.dev===before.a.dev,aTookOldDevOfB:after.a.dev===before.b.dev};
    expect([after.a.uuid,after.b.uuid]).toEqual([before.a.uuid,before.b.uuid]);
    // 前提（番号が実際に入れ替わった）を確かめてから、番号が変わっても ino が同じことを見る。
    expect(after.a.dev).not.toBe(before.a.dev);expect([after.a.folderIno,after.b.folderIno]).toEqual([before.a.folderIno,before.b.folderIno]);
  },60_000);
  it('tells apart a card with the same name that came back at the same mount point and dev: only the UUID differs, and no folder is made on it',async()=>{
    const chosen=(await listVolumes(io)).find(item=>item.mountPoint===a!.mountPoint)!,twin=await createExfatImage({label:a!.label});
    try{
      await detachImage(a!.mountPoint);await detachImage(twin.mountPoint);twin.mountPoint=await attachImage(twin.dmg);
      const now=(await listVolumes(io)).find(item=>item.mountPoint===chosen.mountPoint);notes.twin={chosen,now};
      // 前提（同じ取り付け先・同じ dev）が実際に起きたことを先に確かめる（起きていなければこの試験は何も確かめていない）。
      expect(now).toMatchObject({mountPoint:chosen.mountPoint,dev:chosen.dev});expect(now!.uuid).not.toBe(chosen.uuid);
      await expect(ensureCopyFolder(io,chosen,chosen.mountPoint,[COPY_ROOT_NAME])).rejects.toThrow('選んだ時と違います');expect(existsSync(join(twin.mountPoint,COPY_ROOT_NAME))).toBe(false);
    }finally{await destroyExfatImage(twin);a!.mountPoint=await attachImage(a!.dmg);}
  },120_000);
});
