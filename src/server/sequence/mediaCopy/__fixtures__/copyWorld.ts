import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {faultyIo,nodeCopyIo,type CopyIo,type FaultyIo,type IoFault} from '../io';
import {exfatEmptyInodes,fakeClock,fakeVolumesIo,type FakeClock,type FakeVolumesIo} from '../fakeIo';

export const GiB=2**30,MiB=2**20;
export interface CopyWorld {root:string;home:string;sd:string;ssd:string;nas:string;ro:string;clock:FakeClock;faulty:FaultyIo;io:FakeVolumesIo;faults:IoFault[];cleanup():Promise<void>}
/**
 * 一時フォルダーに「このMac（root 全体・ホームは root/home）・SD（exFAT）・SSD（APFS）・NAS（ネットワーク）・読み取り専用」を作る。faults は後から push できる。
 * exfatEmptyInodes: 空のファイルの ino を exFAT と同じく共通の仮の値にする（exfatEmptyInodes。どのボリュームにも効く）。
 */
export async function copyWorld(options:{sdProbeBytesPerSecond?:number;exfatEmptyInodes?:boolean}={}):Promise<CopyWorld>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'media-copy-world-'))),home=join(root,'home'),sd=join(root,'sd'),ssd=join(root,'ssd'),nas=join(root,'nas'),ro=join(root,'ro');
  for(const dir of [join(home,'Movies'),sd,ssd,nas,ro])await mkdir(dir,{recursive:true});
  const faults:IoFault[]=[],clock=fakeClock();
  // 失敗の注入は一番外側に重ねる（fakeVolumesIo の mounts・statfs・volumeDetails は下の層を呼ばないので、内側に置くと注入も記録も届かない）。faulty と io は同じもの。
  // 偽ボリュームはどれも同じ一時フォルダーの上なので dev は共通。ドライブの入れ替わり（dev の違い）はこの世界では再現できず、exFAT の任意試験（volumes.exfat.test.ts・Task 16）でしか確かめられない。
  const exfat=<T extends CopyIo>(base:T):T=>options.exfatEmptyInodes?exfatEmptyInodes(base):base;
  const io=faultyIo(exfat(fakeVolumesIo(nodeCopyIo,{home,clock,volumes:[
    {mountPoint:root,uuid:'BOOT',kind:'boot-data',container:'disk3',capacity:500*GiB,free:300*GiB},
    {mountPoint:sd,uuid:'SD',kind:'external',fsType:'exfat',removable:true,capacity:64*GiB,free:10*GiB},
    {mountPoint:ssd,uuid:'SSD',kind:'external',container:'disk9',capacity:1000*GiB,free:900*GiB},
    {mountPoint:nas,uuid:'NAS',kind:'external',fsType:'smbfs',local:false,capacity:1000*GiB,free:900*GiB},
    {mountPoint:ro,uuid:'RO',kind:'external',readOnly:true,capacity:100*GiB,free:50*GiB}],
    speeds:[{prefix:sd,purpose:'probe',bytesPerSecond:options.sdProbeBytesPerSecond??MiB,virtual:true}]})),faults);
  return {root,home,sd,ssd,nas,ro,clock,faulty:io,io,faults,cleanup:()=>rm(root,{recursive:true,force:true})};
}
