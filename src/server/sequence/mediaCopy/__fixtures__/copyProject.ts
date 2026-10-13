import {mkdir,realpath,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../../core/sequence/model';
import {SequenceStore} from '../../store';
import {buildEmptyDocument} from '../../createDocuments';
import {registerSequenceReference} from '../../references';
import {listVolumes} from '../volumes';
import {SpaceReservations} from '../space';
import {resolveCopyDestination,type ChosenDestination} from '../destinations';
import {copyWorld,type CopyWorld} from './copyWorld';

/** 16 ビット・モノラル・8kHz の WAV（mib MiB の標本）。seed で中身を変える。 */
export function wav(mib:number,seed=0):Buffer{
  const samples=mib*1024*1024/2,b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE((i+seed)%100,i);return b;
}

export interface CopyProject extends CopyWorld {project:string;assets:SequenceAsset[];sources:string[];destination:ChosenDestination}
/**
 * このMac の上の試験の案件（名前「案件」）に、SD の WAV をリンク素材として登録する。コピー先は SSD（開始時の確認を通したもの）。
 * exfatEmptyInodes: 空のファイルの ino を exFAT と同じく共通の仮の値にする（copyWorld と同じ）。folder: 案件のフォルダー名（既定 case）。sdProbeBytesPerSecond: SD の試し読みの速さ（copyWorld と同じ）。
 */
export async function copyProject(options:{files?:Array<{name:string;mib:number}>;exfatEmptyInodes?:boolean;folder?:string;sdProbeBytesPerSecond?:number}={}):Promise<CopyProject>{
  const world=await copyWorld({...(options.exfatEmptyInodes?{exfatEmptyInodes:true}:{}),...(options.sdProbeBytesPerSecond?{sdProbeBytesPerSecond:options.sdProbeBytesPerSecond}:{})}),dir=join(world.home,'Projects',options.folder??'case');await mkdir(dir,{recursive:true});
  new SequenceStore(dir).save({document:buildEmptyDocument('案件',()=>'12345678-aaaa-bbbb-cccc-000000000000'),expectedSavedRevision:null,executionId:'seed'});
  const project=await realpath(dir),sources:string[]=[],assets:SequenceAsset[]=[];
  for(const [index,file] of (options.files??[{name:'clip-1.wav',mib:6},{name:'clip-2.wav',mib:6}]).entries()){
    const path=join(world.sd,file.name);await writeFile(path,wav(file.mib,index));sources.push(path);assets.push(await registerSequenceReference(project,path));
  }
  const ssd=(await listVolumes(world.io)).find(volume=>volume.uuid==='SSD')!;
  const destination=await resolveCopyDestination(world.io,{project:{name:'案件',id:'12345678-aaaa',root:project},sources:await Promise.all(sources.map(async path=>({path,sizeBytes:(await stat(path)).size})))},
    {key:'volume:SSD',uuid:'SSD',dev:ssd.dev},new SpaceReservations());
  return {...world,project,assets,sources,destination};
}
