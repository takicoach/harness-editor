import { join } from 'node:path';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { sequenceSampleCount } from '../../preview/native/audioMixer';
import { HttpError } from '../http';
import { resolveFfprobeBin } from '../resolveFfmpeg';
import { probeExportFile,verifyExportProbe } from './exportVerification';
import { digest,exportDirectory,hashExportFile,persistExport,readExportInput,readExportRecord,readRegular,type ExportRecord } from './exportRecords';

/** Establish a baseline once, on demand. This is not proof of the pre-upgrade file's historic bytes. */
export async function prepareLegacyExport(root:string,record:ExportRecord,signal?:AbortSignal):Promise<ExportRecord> {
  if(record.version!==0||record.output)return record;
  if(record.status.phase!=='complete')throw new HttpError(409,'動画の書き出しはまだ完了していません');
  const document=readExportInput(root,record),directory=exportDirectory(root,record.status.id),file=join(directory,'output.mp4');
  const verificationBytes=readRegular(join(directory,'verification.json'),2*1024*1024),verification=JSON.parse(verificationBytes);
  const sampleCount=sequenceSampleCount(new ScenePlan(document),48000);
  if(verification.revision!==record.status.revision||verification.contentHash!==record.status.contentHash||verification.audio?.sampleCount!==sampleCount)
    throw new Error('以前の書き出しの検証記録と入力が一致しません');
  verifyExportProbe(document,verification.probe,sampleCount);
  const before=await hashExportFile(file,signal),ffprobe=resolveFfprobeBin();if(!ffprobe.ok)throw new Error(ffprobe.message);
  verifyExportProbe(document,await probeExportFile(ffprobe.bin,file,{signal,maxBuffer:2*1024*1024}),sampleCount);
  const after=await hashExportFile(file,signal);
  if(before.signature!==after.signature||before.sha256!==after.sha256)throw new Error('以前の動画が確認中に変更されました');
  const current=readExportRecord(root,record.status.id);
  if(current.version!==0||JSON.stringify(current.legacy)!==JSON.stringify(record.legacy)||digest(readRegular(join(directory,'verification.json'),2*1024*1024))!==digest(verificationBytes))
    throw new Error('以前の書き出し記録が確認中に変更されました');
  signal?.throwIfAborted();readExportInput(root,record);
  record.output={sha256:after.sha256,bytes:after.bytes,verificationHash:digest(verificationBytes)};
  // Concurrent first downloads may verify, but only the first may publish the baseline.
  persistExport(directory,record,true);return readExportRecord(root,record.status.id);
}
