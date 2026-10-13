import {afterEach,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CREATE_EXCLUSIVE,READ_ONLY,SimulatedCrash,copyIo,copyIoTesting,faultyIo,mountKind,nodeCopyIo,parseMountLine,parsePsStart,readPsStart,runCommand,volumeDetailsFromJson,type CopyIo} from './io';
import {fakeClock,fakeVolumesIo,realTimeClock} from './fakeIo';

const dirs:string[]=[];afterEach(async()=>{copyIoTesting.use(undefined);for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const temp=async()=>{const dir=await mkdtemp(join(tmpdir(),'media-copy-io-'));dirs.push(dir);return dir;};
const GiB=2**30;

it('reads mount lines: local exFAT, network SMB, the sealed root, the data volume, spaces in names, nested folders under /Volumes',()=>{
  expect(parseMountLine('/dev/disk4s1 on /Volumes/SD 1 (exfat, local, nodev, nosuid, noowners, noatime, fskit)')).toEqual({device:'/dev/disk4s1',mountPoint:'/Volumes/SD 1',fsType:'exfat',local:true,readOnly:false,kind:'external'});
  expect(parseMountLine('//user@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)')).toMatchObject({fsType:'smbfs',local:false,kind:'external'});
  expect(parseMountLine('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)')).toMatchObject({kind:'boot-system',readOnly:true});
  expect(parseMountLine('/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)')).toMatchObject({kind:'boot-data',readOnly:false});
  expect(parseMountLine('/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)')).toMatchObject({kind:'other'});
  expect(parseMountLine('/dev/disk5s1 on /Volumes/x/y (apfs, local, nodev, nosuid)')).toMatchObject({mountPoint:'/Volumes/x/y',kind:'other'});
  expect(mountKind('/Volumes/x')).toBe('external');expect(mountKind('/Volumes/x/y')).toBe('other');expect(mountKind('/Volumes')).toBe('other');
  expect(parseMountLine('garbage')).toBeUndefined();
});
it('opens read-only without following links, creates only exclusively, and reads and writes at the given position',async()=>{
  const dir=await temp(),file=join(dir,'a.bin'),link=join(dir,'link.bin');await writeFile(file,'abc');await symlink(file,link);
  await expect(nodeCopyIo.open(link,READ_ONLY)).rejects.toMatchObject({code:'ELOOP'});
  await expect(nodeCopyIo.open(file,CREATE_EXCLUSIVE,0o644)).rejects.toMatchObject({code:'EEXIST'});
  const out=await nodeCopyIo.open(join(dir,'b.bin'),CREATE_EXCLUSIVE,0o644);expect(await out.write(Buffer.from('xyz'),0)).toBe(3);expect(await out.write(Buffer.from('Q'),5)).toBe(1);await out.sync();await out.close();
  expect(await readFile(join(dir,'b.bin'))).toEqual(Buffer.from('xyz\0\0Q','latin1'));
  const input=await nodeCopyIo.open(join(dir,'b.bin'),READ_ONLY),part=Buffer.alloc(3);expect(await input.read(part,1)).toBe(3);expect(part).toEqual(Buffer.from('yz\0','latin1'));
  expect(await input.read(Buffer.alloc(4),6)).toBe(0);await input.close();
});
it('injects errno failures and simulated crashes at the n-th call, and records flags and bytes',async()=>{
  const dir=await temp(),file=join(dir,'a.bin');await writeFile(file,Buffer.alloc(10,1));
  const io=faultyIo(nodeCopyIo,[{op:'write',nth:2,error:'ENOSPC'},{op:'rename',crash:true}]);
  const out=await io.open(join(dir,'b.bin'),CREATE_EXCLUSIVE,0o644);await out.write(Buffer.alloc(4),0);
  await expect(out.write(Buffer.alloc(4),4)).rejects.toMatchObject({code:'ENOSPC'});await out.close();
  await expect(io.rename(join(dir,'b.bin'),join(dir,'c.bin'))).rejects.toBeInstanceOf(SimulatedCrash);
  const input=await io.open(file,READ_ONLY);expect(await input.read(Buffer.alloc(16),0)).toBe(10);await input.close();
  expect(io.calls.find(call=>call.op==='open'&&call.path===file)?.flags).toBe(READ_ONLY);
  expect(io.calls.find(call=>call.op==='read'&&call.path===file)?.bytes).toBe(10);
  expect(io.calls.find(call=>call.op==='rename')).toMatchObject({from:join(dir,'b.bin'),path:join(dir,'c.bin')});
});
it('closes the real file before throwing a failed close or a crash in the middle of reading, writing or syncing',async()=>{
  const dir=await temp(),closes:string[]=[];for(const name of ['a','b','c','d'])await writeFile(join(dir,`${name}.bin`),'0123');
  const spy:CopyIo={...nodeCopyIo,open:async(path,flags,mode)=>{const file=await nodeCopyIo.open(path,flags,mode);return {...file,close:async()=>{closes.push(path);await file.close();}};}};
  const io=faultyIo(spy,[{op:'read',path:/a\.bin$/,crash:true},{op:'close',path:/b\.bin$/,error:'EIO'},{op:'write',path:/c\.bin$/,error:'ENOSPC'},{op:'sync',path:/d\.bin$/,crash:true}]);
  const a=await io.open(join(dir,'a.bin'),READ_ONLY);await expect(a.read(Buffer.alloc(4),0)).rejects.toBeInstanceOf(SimulatedCrash);expect(closes).toEqual([join(dir,'a.bin')]);
  await a.close();expect(closes).toEqual([join(dir,'a.bin')]);
  const b=await io.open(join(dir,'b.bin'),READ_ONLY);await expect(b.close()).rejects.toMatchObject({code:'EIO'});expect(closes).toEqual([join(dir,'a.bin'),join(dir,'b.bin')]);
  const c=await io.open(join(dir,'c.bin'),READ_ONLY);await expect(c.write(Buffer.from('x'),0)).rejects.toMatchObject({code:'ENOSPC'});expect(closes).toHaveLength(2);await c.close();expect(closes).toHaveLength(3);
  const d=await io.open(join(dir,'d.bin'),READ_ONLY);await expect(d.sync()).rejects.toBeInstanceOf(SimulatedCrash);expect(closes.at(-1)).toBe(join(dir,'d.bin'));
});
it('reaches the fake volumes when the faults are layered outside them (the copyWorld order), keeping the fake type',async()=>{
  const dir=await temp(),sd=join(dir,'sd');await mkdir(sd);
  const fake=fakeVolumesIo(nodeCopyIo,{home:dir,volumes:[{mountPoint:sd,uuid:'SD',kind:'external',capacity:64*GiB,free:10*GiB}]});
  const io=faultyIo(fake,[{op:'mounts',nth:2,error:'EIO'},{op:'statfs',error:'EIO'},{op:'volumeDetails',error:'ENXIO'}]);
  expect(await io.mounts()).toHaveLength(1);await expect(io.mounts()).rejects.toMatchObject({code:'EIO'});
  await expect(io.statfs(sd)).rejects.toMatchObject({code:'EIO'});await expect(io.volumeDetails(sd)).rejects.toMatchObject({code:'ENXIO'});
  expect(io.calls.map(call=>call.op)).toEqual(['mounts','mounts','statfs','volumeDetails']);
  io.volumes[0]!.free=GiB;expect((await fake.statfs(sd)).bavail).toBe(GiB/4096);
});
it('fakes volumes like real ones: EXDEV across volumes, EROFS on a read-only one, ENOENT for a missing path',async()=>{
  const dir=await temp(),[sd,ssd,ro,locked]=['sd','ssd','ro','locked'].map(name=>join(dir,name)) as [string,string,string,string];
  for(const folder of [sd,ssd,ro,locked])await mkdir(folder);await writeFile(join(sd,'a.bin'),'a');await writeFile(join(ro,'r.bin'),'r');
  const io=fakeVolumesIo(nodeCopyIo,{home:dir,volumes:[{mountPoint:sd,uuid:'SD',kind:'external',capacity:GiB,free:GiB/2},{mountPoint:ssd,uuid:'SSD',kind:'external',capacity:GiB,free:GiB/2},
    {mountPoint:ro,uuid:'RO',kind:'external',readOnly:true,capacity:GiB,free:GiB/2},{mountPoint:locked,uuid:'LOCKED',kind:'external',writable:false,capacity:GiB,free:GiB/2}]});
  await expect(io.rename(join(sd,'a.bin'),join(ssd,'a.bin'))).rejects.toMatchObject({code:'EXDEV'});
  await expect(io.rename(join(sd,'a.bin'),join(dir,'a.bin'))).rejects.toMatchObject({code:'EXDEV'});
  await io.rename(join(sd,'a.bin'),join(sd,'b.bin'));expect(await readdir(sd)).toEqual(['b.bin']);expect(await readdir(ssd)).toEqual([]);
  await expect(io.open(join(ro,'new.bin'),CREATE_EXCLUSIVE,0o644)).rejects.toMatchObject({code:'EROFS'});
  await expect(io.mkdir(join(ro,'d'))).rejects.toMatchObject({code:'EROFS'});await expect(io.mkdir(join(locked,'d'))).rejects.toMatchObject({code:'EROFS'});
  await expect(io.unlink(join(ro,'r.bin'))).rejects.toMatchObject({code:'EROFS'});await expect(io.rename(join(ro,'r.bin'),join(ro,'s.bin'))).rejects.toMatchObject({code:'EROFS'});
  await expect(io.open(join(ro,'r.bin'),constants.O_WRONLY)).rejects.toMatchObject({code:'EROFS'});await expect(io.open(join(ro,'missing'),constants.O_WRONLY)).rejects.toMatchObject({code:'ENOENT'});
  // 読み取り専用でも、既にある名前への作成は EEXIST、無いものの削除・移動は ENOENT（本物どおり）
  await expect(io.mkdir(join(ro,'r.bin'))).rejects.toMatchObject({code:'EEXIST'});await expect(io.open(join(ro,'r.bin'),CREATE_EXCLUSIVE,0o644)).rejects.toMatchObject({code:'EEXIST'});
  await expect(io.unlink(join(ro,'missing'))).rejects.toMatchObject({code:'ENOENT'});await expect(io.rename(join(ro,'missing'),join(ro,'s.bin'))).rejects.toMatchObject({code:'ENOENT'});
  const input=await io.open(join(ro,'r.bin'),READ_ONLY);expect(await input.read(Buffer.alloc(4),0)).toBe(1);await input.close();
  expect(await readdir(ro)).toEqual(['r.bin']);expect(await readdir(locked)).toEqual([]);
  await expect(io.statfs(join(sd,'missing'))).rejects.toMatchObject({code:'ENOENT'});
});
it('fakes volumes, free space and a virtual clock over real temporary folders',async()=>{
  const dir=await temp(),clock=fakeClock(),sd=join(dir,'sd');await mkdir(sd);await writeFile(join(sd,'x'),'x');
  const io=fakeVolumesIo(nodeCopyIo,{home:join(dir,'home'),clock,volumes:[{mountPoint:sd,uuid:'SD',kind:'external',fsType:'exfat',capacity:64*GiB,free:10*GiB}],
    speeds:[{prefix:sd,purpose:'probe',bytesPerSecond:2**20,virtual:true}]});
  expect(await io.mounts()).toEqual([expect.objectContaining({mountPoint:sd,kind:'external',fsType:'exfat',local:true})]);
  expect(await io.volumeDetails(sd)).toEqual({uuid:'SD',writable:true});
  expect(await io.statfs(join(sd,'x'))).toEqual({bsize:4096,bavail:10*GiB/4096,blocks:64*GiB/4096});
  const before=clock.now();await io.throttle('probe',join(sd,'a.mp4'),2**20);expect(clock.now()-before).toBe(1000);
  await io.throttle('probe',`${sd}2/a.mp4`,2**20);await io.throttle('copy',join(sd,'a.mp4'),2**20);expect(clock.now()-before).toBe(1000);
  io.volumes[0]!.free=GiB;expect((await io.statfs(sd)).bavail).toBe(GiB/4096);expect(io.home()).toBe(join(dir,'home'));
});
it('refuses speed rules it cannot time: virtual without a clock, real waiting against a stopped fake clock',()=>{
  const none={home:'/nowhere',volumes:[]},virtual={prefix:'/x',purpose:'copy' as const,bytesPerSecond:1,virtual:true},waiting={prefix:'/x',purpose:'copy' as const,bytesPerSecond:1};
  expect(()=>fakeVolumesIo(nodeCopyIo,{...none,speeds:[virtual]})).toThrow('時計');
  expect(()=>fakeVolumesIo(nodeCopyIo,{...none,clock:fakeClock(),speeds:[waiting]})).toThrow('時計');
  expect(()=>fakeVolumesIo(nodeCopyIo,{...none,clock:realTimeClock(),speeds:[waiting,virtual]})).not.toThrow();
  expect(()=>fakeVolumesIo(nodeCopyIo,{...none,speeds:[waiting]})).not.toThrow();expect(()=>fakeVolumesIo(nodeCopyIo,{...none,clock:fakeClock(),speeds:[virtual]})).not.toThrow();
});
it('a real-time clock follows the monotonic clock, really waits for slow rules, and can be pushed ahead',async()=>{
  const clock=realTimeClock(),io=fakeVolumesIo(nodeCopyIo,{home:'/nowhere',volumes:[],clock,speeds:[{prefix:'/x',purpose:'copy',bytesPerSecond:1000}]});
  const start=clock.now();clock.advance(5000);expect(clock.now()-start).toBeGreaterThanOrEqual(5000);
  await io.throttle('copy','/x/a.mp4',50);expect(io.now()-start).toBeGreaterThanOrEqual(5045);
});
it('knows its own process and start time, and tells a finished process from a start time it could not read',async()=>{
  expect(nodeCopyIo.processAlive(process.pid)).toBe(true);expect(nodeCopyIo.processAlive(4_206_649)).toBe(false);
  for(const pid of [0,-1,1.5,Number.NaN])expect(nodeCopyIo.processAlive(pid)).toBe(false);
  const started=await nodeCopyIo.processStartedAt(process.pid);expect(started).toBeDefined();
  expect(Math.abs(started!-nodeCopyIo.self.startedAt)).toBeLessThan(3000);
  expect(await nodeCopyIo.processStartedAt(1)).toBeLessThan(nodeCopyIo.self.startedAt-2000);
  const child=spawn('/usr/bin/true',[],{stdio:'ignore'}),pid=child.pid!;await once(child,'exit');expect(await nodeCopyIo.processStartedAt(pid)).toBeUndefined();
  await expect(nodeCopyIo.processStartedAt(4_206_649)).rejects.toThrow('ps');await expect(nodeCopyIo.processStartedAt(0)).rejects.toThrow('pid');
});
it('reads ps in UTC: no such process is undefined, every other answer it cannot read is an error',()=>{
  expect(parsePsStart('Sat Oct  4 10:12:13 2026')).toBe(Date.UTC(2026,9,4,10,12,13));expect(parsePsStart('')).toBeUndefined();expect(parsePsStart('Sat Foo  4 10:12:13 2026')).toBeUndefined();
  expect(readPsStart({code:0,stdout:'Sun Sep 13 01:11:56 2026    \n',stderr:''})).toBe(Date.UTC(2026,8,13,1,11,56));
  expect(readPsStart({code:1,stdout:'',stderr:''})).toBeUndefined();
  expect(()=>readPsStart({code:1,stdout:'',stderr:'ps: process id too large: 4206649'})).toThrow('ps');
  for(const result of [{code:2,stdout:'',stderr:''},{code:null,stdout:'',stderr:''},{code:0,stdout:'garbage',stderr:''},{code:0,stdout:'',stderr:''}])expect(()=>readPsStart(result)).toThrow('ps');
});
it('stops a command that outlives its time with SIGTERM, then SIGKILL after a short grace',async()=>{
  const started=Date.now();
  await expect(runCommand('/bin/sh',['-c','trap "" TERM; exec sleep 30'],{timeoutMs:200,killAfterMs:200})).rejects.toThrow('時間内');
  expect(Date.now()-started).toBeLessThan(3000);
  // 孫のプロセスが出力を握ったままでも、本体が終わった時点で返す。
  const dir=await temp(),pidFile=join(dir,'pid'),again=Date.now();
  await expect(runCommand('/bin/sh',['-c',`trap "" TERM; sleep 20 & echo $! > '${pidFile}'; wait`],{timeoutMs:300,killAfterMs:200})).rejects.toThrow('時間内');
  expect(Date.now()-again).toBeLessThan(3000);try{process.kill(Number(await readFile(pidFile,'utf8')),'SIGKILL');}catch{/* もう終わっている */}
  // 本体が先に終わり孫が出力を握っている時は、時間切れの時点で（猶予を待たずに）返し、出力の読み口を閉じる（孫の後の書き込みは届かない）。
  const marker=join(dir,'wrote'),late=Date.now();
  await expect(runCommand('/bin/sh',['-c',`(sleep 1; echo late && echo wrote > '${marker}') & exit 0`],{timeoutMs:300,killAfterMs:5000})).rejects.toThrow('時間内');
  expect(Date.now()-late).toBeLessThan(900);await new Promise(resolve=>setTimeout(resolve,1500-(Date.now()-late)));
  await expect(readFile(marker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  expect(await runCommand('/bin/sh',['-c','echo ok; echo no >&2; exit 3'])).toEqual({code:3,stdout:'ok\n',stderr:'no\n'});
  expect((await runCommand('/usr/bin/tr',['a-z','A-Z'],{input:'abc'})).stdout).toBe('ABC');
});
it('reads only well-typed fields from the diskutil answer',()=>{
  expect(volumeDetailsFromJson({VolumeUUID:'U',DiskUUID:'D',APFSContainerReference:'disk3',WritableVolume:false,Other:1})).toEqual({uuid:'U',diskUuid:'D',container:'disk3',writable:false});
  expect(volumeDetailsFromJson({VolumeUUID:7,DiskUUID:'',APFSContainerReference:null,WritableVolume:'yes'})).toEqual({});
  // 取り外し可能か（diskutil の Removable Media: Removable/Fixed）: SD カードは true、外付け SSD・内蔵は false。
  expect(volumeDetailsFromJson({VolumeUUID:'U',RemovableMedia:true})).toEqual({uuid:'U',removable:true});
  expect(volumeDetailsFromJson({VolumeUUID:'U',RemovableMedia:false})).toEqual({uuid:'U',removable:false});
  expect(volumeDetailsFromJson({VolumeUUID:'U',RemovableMedia:'Removable'})).toEqual({uuid:'U'});
  for(const value of [null,[],'x',3])expect(()=>volumeDetailsFromJson(value)).toThrow('diskutil');
});
it.skipIf(process.platform!=='darwin')('reads the boot data volume identity with diskutil (read only)',async()=>{
  const details=await nodeCopyIo.volumeDetails('/System/Volumes/Data');
  expect(details.uuid).toMatch(/^[0-9A-F-]{36}$/i);expect(details.container).toMatch(/^disk\d+$/);expect(details.writable).toBe(true);
  expect((await nodeCopyIo.mounts()).some(mount=>mount.kind==='boot-data'&&mount.mountPoint==='/System/Volumes/Data')).toBe(true);
});
it('uses the real world by default and lets only a test run swap it',()=>{
  expect(copyIo()).toBe(nodeCopyIo);const fake={...nodeCopyIo};
  copyIoTesting.use(fake);expect(copyIo()).toBe(fake);copyIoTesting.use(undefined);expect(copyIo()).toBe(nodeCopyIo);
  const vitest=process.env.VITEST;delete process.env.VITEST;
  try{expect(()=>copyIoTesting.use(fake)).toThrow('試験');expect(copyIo()).toBe(nodeCopyIo);}finally{if(vitest!==undefined)process.env.VITEST=vitest;}
});
