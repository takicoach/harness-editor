import {afterEach,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {COPY_ROOT_NAME,CopyFolderError,assertCopyFolder,copyFolderName,ensureCopyFolder,listVolumes,volumeOfPath} from './volumes';
import {copyWorld,type CopyWorld} from './__fixtures__/copyWorld';

let world:CopyWorld;afterEach(async()=>{await world?.cleanup();});

it('identifies volumes by UUID and dev, with the space-sharing unit, and marks network and read-only ones',async()=>{
  world=await copyWorld();const list=await listVolumes(world.io),by=(uuid:string)=>list.find(volume=>volume.uuid===uuid||volume.uuid===`network:/dev/fake-${uuid}`);
  expect(by('BOOT')).toMatchObject({kind:'boot-data',label:'このMac',spaceUnit:'apfs:disk3',writable:true,network:false});
  expect(by('SD')).toMatchObject({kind:'external',label:'sd',fsType:'exfat',spaceUnit:'volume:SD',writable:true});
  expect(by('SSD')).toMatchObject({spaceUnit:'apfs:disk9'});
  expect(by('NAS')).toMatchObject({network:true,writable:false});expect(by('RO')).toMatchObject({writable:false});
  expect(by('SD')!.dev).toBe((await stat(world.sd)).dev);
});
it('finds the volume of a path through links; the home is on the boot data volume',async()=>{
  world=await copyWorld();await writeFile(join(world.sd,'clip.mp4'),'x');await symlink(join(world.sd,'clip.mp4'),join(world.home,'link.mp4'));
  expect((await volumeOfPath(world.io,join(world.sd,'clip.mp4')))?.uuid).toBe('SD');
  expect((await volumeOfPath(world.io,join(world.home,'link.mp4')))?.uuid).toBe('SD');
  expect((await volumeOfPath(world.io,join(world.home,'Movies')))?.uuid).toBe('BOOT');
});
it('does not take a folder left under a mount point on another device for that volume',async()=>{
  world=await copyWorld();const file=join(world.sd,'clip.mp4');await writeFile(file,'x');
  const io={...world.io,stat:async(path:string)=>{const info=await world.io.stat(path);return path===file?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:info.dev+1}):info;}};
  expect(await volumeOfPath(io,file)).toBeUndefined();
});
it('names the folder after the project name and the first 8 characters of its ID',()=>{
  expect(copyFolderName('0727 撮影/本番:1','abcdef12-3456-7890')).toBe('0727 撮影_本番_1-abcdef12');
  expect(copyFolderName('  ..  ','12345678-x')).toBe('案件-12345678');expect(copyFolderName('a'.repeat(200),'12345678').length).toBe(80+9);
  // 文字の途中（サロゲートの片割れ）で切らず、フォルダー名の上限（255 バイト）に収まる。
  expect(copyFolderName(`${'a'.repeat(79)}${'😀'.repeat(10)}`,'12345678')).toBe(`${'a'.repeat(79)}😀-12345678`);
  const emoji=copyFolderName('😀'.repeat(100),'12345678');expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(255);expect(Buffer.from(emoji).toString()).toBe(emoji);
});
it('creates the copy folder one level at a time without recursion and checks each level',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!;
  const folder=await ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME,'案件-12345678']);
  expect(folder.path).toBe(join(world.ssd,COPY_ROOT_NAME,'案件-12345678'));expect(folder).toMatchObject({dev:volume.dev,ino:(await stat(folder.path)).ino});
  expect(world.faulty.calls.filter(call=>call.op==='mkdir').map(call=>call.path)).toEqual([join(world.ssd,COPY_ROOT_NAME),folder.path]);
  expect(await ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME,'案件-12345678'])).toEqual(folder);
});
it('stops at a link in the middle and creates nothing behind it',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!;await symlink(world.home,join(world.ssd,COPY_ROOT_NAME));
  await expect(ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME,'案件-12345678'])).rejects.toBeInstanceOf(CopyFolderError);
  expect(existsSync(join(world.home,'案件-12345678'))).toBe(false);
  // 置き場所（base）そのものがリンクでも止める。
  await symlink(world.ssd,join(world.home,'ssd-link'));
  await expect(ensureCopyFolder(world.io,volume,join(world.home,'ssd-link'),['案件-12345678'])).rejects.toThrow('リンク');expect(existsSync(join(world.ssd,'案件-12345678'))).toBe(false);
  // 置き場所の途中の「..」でたどり直さない（リンクと同じく、見た場所と違う所へ作らない）。
  await expect(ensureCopyFolder(world.io,volume,`${world.ssd}/../ssd`,['案件-12345678'])).rejects.toThrow('不正');expect(existsSync(join(world.ssd,'案件-12345678'))).toBe(false);
});
it('never recreates a volume that has gone away, and refuses a base on another device',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!;await rm(world.ssd,{recursive:true});
  await expect(ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME])).rejects.toThrow('作り直しません');expect(existsSync(world.ssd)).toBe(false);
  await mkdir(world.ssd);await expect(ensureCopyFolder(world.io,{...volume,dev:volume.dev+1},world.ssd,[COPY_ROOT_NAME])).rejects.toThrow('選んだ時と違います');
});
it('refuses another drive that took the same dev: the dev follows the disk slot, so the UUID is checked too',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!,mounts=()=>world.faulty.calls.filter(call=>call.op==='mounts').length;
  await ensureCopyFolder(world.io,volume,world.ssd,[]);const before=mounts();   // 作業の途中の mounts の回数（Task 10 の nth）をずらさない
  world.io.volumes.find(item=>item.uuid==='SSD')!.uuid='OTHER';
  await expect(ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME])).rejects.toThrow('選んだ時と違います');expect(existsSync(join(world.ssd,COPY_ROOT_NAME))).toBe(false);
  expect(mounts()).toBe(before);
});
it('re-checks the folder for each item: same volume UUID and dev, same folder dev and ino',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!,folder=await ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME]);
  await assertCopyFolder(world.io,folder,volume);
  // 同じ UUID でも dev が選んだ時と違えば止める（exFAT の ino は小さな値で別のカードと重なりうるので、ino だけには頼らない）。
  await expect(assertCopyFolder(world.io,folder,{...volume,dev:volume.dev+1})).rejects.toThrow('取り外されたか');
  await rm(folder.path,{recursive:true});await mkdir(folder.path);await expect(assertCopyFolder(world.io,folder,volume)).rejects.toThrow('置き換えられました');
  world.io.volumes.splice(world.io.volumes.findIndex(item=>item.uuid==='SSD'),1);await expect(assertCopyFolder(world.io,folder,volume)).rejects.toThrow('取り外されたか');
});
it('lists a network volume without touching its root (no stat, no diskutil), never writable, and finds its paths by place only',async()=>{
  world=await copyWorld();await writeFile(join(world.nas,'clip.mp4'),'x');const list=await listVolumes(world.io),nas=list.find(item=>item.network)!;
  expect(nas).toMatchObject({uuid:'network:/dev/fake-NAS',mountPoint:world.nas,network:true,writable:false});
  expect(world.faulty.calls.filter(call=>call.path===world.nas)).toEqual([]);   // 切れかけの NAS で一覧ごと止まらない
  expect((await volumeOfPath(world.io,join(world.nas,'clip.mp4'),list))?.uuid).toBe(nas.uuid);
});
it('leaves out a local volume whose identity cannot be read, and falls back to the DiskUUID',async()=>{
  world=await copyWorld();world.faults.push({op:'volumeDetails',path:/\/ro$/,error:'EIO'});
  const io={...world.io,volumeDetails:async(mountPoint:string)=>mountPoint===world.sd?{writable:true}:mountPoint===world.ssd?{diskUuid:'DISK-SSD',container:'disk9'}:world.io.volumeDetails(mountPoint)};
  const list=await listVolumes(io),places=list.map(item=>item.mountPoint);
  expect(places).not.toContain(world.sd);expect(places).not.toContain(world.ro);expect(places).toContain(world.root);
  expect(list.find(item=>item.uuid==='DISK-SSD')).toMatchObject({mountPoint:world.ssd,spaceUnit:'apfs:disk9'});
});
it('stops when a level it created turns out to be on another drive',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!,level=join(world.ssd,COPY_ROOT_NAME);
  const io={...world.io,lstat:async(path:string)=>{const info=await world.io.lstat(path);return path===level?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{dev:info.dev+1}):info;}};
  await expect(ensureCopyFolder(io,volume,world.ssd,[COPY_ROOT_NAME,'案件-12345678'])).rejects.toThrow('別のドライブ');expect(existsSync(join(level,'案件-12345678'))).toBe(false);
});
it('wraps a failed mkdir as a stop of the whole job',async()=>{
  world=await copyWorld();const volume=(await listVolumes(world.io)).find(item=>item.uuid==='SSD')!;world.faults.push({op:'mkdir',error:'EACCES'});
  const error=await ensureCopyFolder(world.io,volume,world.ssd,[COPY_ROOT_NAME]).catch((caught:unknown)=>caught);
  expect(error).toBeInstanceOf(CopyFolderError);expect(error).toMatchObject({stop:true,message:expect.stringContaining('作れません')});
});
it('refuses a network or read-only volume before touching anything',async()=>{
  world=await copyWorld();const list=await listVolumes(world.io),before=world.faulty.calls.length;
  const nas=list.find(item=>item.network)!;   // ネットワークは書き込めると言われても断る
  for(const volume of [nas,{...nas,writable:true},list.find(item=>item.uuid==='RO')!])await expect(ensureCopyFolder(world.io,volume,volume.mountPoint,[COPY_ROOT_NAME])).rejects.toThrow('書き込めない');
  expect(world.faulty.calls.slice(before)).toEqual([]);
});
