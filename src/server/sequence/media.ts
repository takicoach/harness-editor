import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpegBin, resolveFfprobeBin } from '../resolveFfmpeg';
import type { MediaStream, SequenceAsset } from '../../core/sequence/model';
import { ceilTime, compareTime, divideTime, isRational, multiplyTime, rational, rationalFromDecimal, timeNumber, type Rational } from '../../core/sequence/time';
import { parseCube } from '../../preview/native/lut';
import { SharedPreparations } from './sharedPreparation';
import {openSequenceAsset} from './assets';
import {isSequenceReferenceFile} from './references';
import { inspectImageStream, readImageHead, type ImageInspection } from './imageProbe';
import { IMAGE_EXTENSIONS } from '../../shared/createMedia';

export async function managedAssetPath(projectDirectory: string, file: string): Promise<string> {
  if (!file || isAbsolute(file) || file.includes('\\') || file.includes(':') || file.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('素材の保存先が不正です');
  const root = await realpath(projectDirectory), actual = await realpath(resolve(root, file));
  const local = relative(root, actual);
  if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local) || !(await stat(actual)).isFile()) throw new Error('プロジェクト外の素材は読み込めません');
  return actual;
}
export async function cacheDirectory(projectDirectory: string, kind: string): Promise<string> {
  let directory = await realpath(projectDirectory);
  for (const segment of ['.harness', 'cache', kind]) {
    directory = join(directory, segment);
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('素材キャッシュの保存先が不正です');
  }
  return directory;
}
/** The caller owns inputFd until this promise settles, including child close on abort. */
export function run(binary: string, args: string[], signal?: AbortSignal, inputFd?:number): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe',...(inputFd===undefined?[]:[inputFd])], signal });
    let stdout = '', stderr = '', failure:Error|undefined;
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => {
      stdout += text;
      if (stdout.length > 8 * 1024 * 1024) { failure??=new Error('素材情報の応答が大きすぎます');child.kill(); }
    });
    child.stderr!.on('data', (text: string) => { stderr = (stderr + text).slice(-12000); });
    child.on('error', error=>{failure??=error;});
    child.on('close', code => failure?reject(failure):code === 0 ? resolve(stdout) : reject(new Error(`素材の準備に失敗しました: ${stderr || `終了コード ${code}`}`)));
  });
}

/** Publish only verified work; failed post-publish verification retires our own
 * inodes so restoring the original source cannot hit a poisoned PCM cache. */
export async function publishSequenceAudio(temporary:string,destination:string,metadata:unknown,verify:()=>Promise<void>,signal:AbortSignal):Promise<void>{
  const metaTemporary=temporary+'.json';
  const owned:Array<{path:string;dev:number;ino:number}>=[];
  try{
    await writeFile(metaTemporary,JSON.stringify(metadata)+'\n',{flag:'wx'});
    const pcm=await lstat(temporary),meta=await lstat(metaTemporary);
    await verify();signal.throwIfAborted();
    await rename(temporary,destination);owned.push({path:destination,dev:pcm.dev,ino:pcm.ino});
    await rename(metaTemporary,destination+'.json');owned.push({path:destination+'.json',dev:meta.dev,ino:meta.ino});
    await verify();signal.throwIfAborted();
  }catch(error){
    for(const file of owned){
      try{const info=await lstat(file.path);if(info.dev===file.dev&&info.ino===file.ino)await unlink(file.path);}
      catch(cleanup){if((cleanup as NodeJS.ErrnoException).code!=='ENOENT')throw cleanup;}
    }
    throw error;
  }finally{await unlink(metaTemporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function ratio(value: unknown): Rational | undefined {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return undefined;
  const [num, den] = value.split('/').map(Number);
  return den && num ? rational(num, den) : undefined;
}
export interface ProbeStream {
  index: number; codec_type: string; codec_name: string; duration?: string; duration_ts?: number;
  time_base?: string; avg_frame_rate?: string; r_frame_rate?: string; width?: number; height?: number;
  sample_rate?: string; channels?: number; sample_aspect_ratio?: string;
  color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string;
  side_data_list?: Array<{ rotation?: number }>;
  disposition?: { attached_pic?: number };
  nb_read_frames?: string;
}
export interface ProbeResult { streams: ProbeStream[]; format?: { duration?: string } }
/** 登録の検査結果。asset だけが台帳・文書に入る。他は作成・互換判定のための付帯情報（設計 M3c・M4b）。 */
export interface SequenceAssetProbe { asset: SequenceAsset; attachedPictureIndexes: number[]; image?: ImageInspection }
// 受け付ける集合は shared/createMedia.ts の IMAGE_EXTENSIONS と同じにする（決め打ちの二重管理を避ける）。
const IMAGE_FILE = new RegExp(`\\.(${IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join('|')})$`, 'i');

/** Registers an existing project-managed file without rewriting legacy metadata. */
export async function inspectSequenceAsset(projectDirectory: string, file: string, name: string, signal?: AbortSignal): Promise<SequenceAsset> {
  return (await probeSequenceAsset(projectDirectory, file, name, signal)).asset;
}
export async function probeSequenceAsset(projectDirectory: string, file: string, name: string, signal?: AbortSignal): Promise<SequenceAssetProbe> {
  const path = await managedAssetPath(projectDirectory, file);
  return probeSequenceAssetSource(path, file, name, signal);
}

/**
 * FFprobe のストリーム一覧を素材のストリームへ変換する。表紙画像（disposition.attached_pic=1 の映像）は
 * 長さ・fps の検査より前に除き、番号だけ attachedPictureIndexes に残す。残るストリームの index は振り直さない（設計 M4・M4b）。
 */
export function mediaStreamsFromProbe(data: ProbeResult): { streams: MediaStream[]; attachedPictureIndexes: number[] } {
  const streams: MediaStream[] = [], attachedPictureIndexes: number[] = [];
  for (const stream of data.streams) {
    if (stream.codec_type !== 'video' && stream.codec_type !== 'audio') continue;
    if (stream.codec_type === 'video' && stream.disposition?.attached_pic === 1) { attachedPictureIndexes.push(stream.index); continue; }
    const timeBase = ratio(stream.time_base);
    const duration = Number.isSafeInteger(stream.duration_ts) && timeBase
      ? multiplyTime(rational(stream.duration_ts!), timeBase)
      : rationalFromDecimal(stream.duration ?? data.format?.duration ?? '0');
    if (compareTime(duration, rational(0)) <= 0) throw new Error('素材の長さを確認できません');
    const common: MediaStream = { index: stream.index, kind: stream.codec_type, codec: stream.codec_name, duration };
    if (stream.codec_type === 'video') {
      const frameRate = ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate);
      if (!frameRate || !stream.width || !stream.height) throw new Error('映像の寸法またはfpsを確認できません');
      streams.push({ ...common, width: stream.width, height: stream.height, frameRate,
        rotation: stream.side_data_list?.find(s => typeof s.rotation === 'number')?.rotation ?? 0,
        ...(ratio(stream.sample_aspect_ratio?.replace(':', '/')) ? { sampleAspectRatio: ratio(stream.sample_aspect_ratio?.replace(':', '/')) } : {}),
        color: { primaries: stream.color_primaries ?? 'unknown', transfer: stream.color_transfer ?? 'unknown', matrix: stream.color_space ?? 'unknown',
          range: stream.color_range === 'pc' ? 'full' : stream.color_range === 'tv' ? 'limited' : 'unknown' } });
    } else {
      if (!Number(stream.sample_rate) || !stream.channels) throw new Error('音声の形式を確認できません');
      streams.push({ ...common, sampleRate: Number(stream.sample_rate), channels: stream.channels });
    }
  }
  return { streams, attachedPictureIndexes };
}

/** Internal source inspection; its caller must authorize the source path first. */
export async function inspectSequenceAssetSource(path:string,file:string,name:string,signal?:AbortSignal):Promise<SequenceAsset>{
  return (await probeSequenceAssetSource(path, file, name, signal)).asset;
}
export async function probeSequenceAssetSource(path:string,file:string,name:string,signal?:AbortSignal):Promise<SequenceAssetProbe>{
  const before = await stat(path);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  const fingerprint = digest.digest('hex');
  if (/\.cube$/i.test(file)) {
    if (before.size > 64 * 1024 * 1024) throw new Error('LUTファイルは64 MiB以下にしてください');
    parseCube(await readFile(path, 'utf8'));
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('読み込み中に素材が変更されました');
    return { asset: { id: `lut-${fingerprint.slice(0, 24)}`, kind: 'lut', name, file, fingerprint, streams: [] }, attachedPictureIndexes: [] };
  }
  const probe = resolveFfprobeBin(); if (!probe.ok) throw new Error(probe.message);
  const image = IMAGE_FILE.test(file);
  // 画像は1コマずつ復号して数える（壊れた画像でも FFprobe は寸法 0 のストリームを返すため。動く画像の判定にも使う）。
  let data: ProbeResult;
  try { data = JSON.parse(await run(probe.bin, ['-v', 'error', ...(image ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', path], signal)); }
  catch (error) { if (!image || signal?.aborted) throw error; throw new Error('画像を読み取れません', { cause: error }); }
  const head = image ? await readImageHead(path) : undefined;
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('読み込み中に素材が変更されました');
  if (image) {
    const stream = data.streams.find(s => s.codec_type === 'video');
    if (!stream) throw new Error('画像を読み取れません');
    return { asset: { id: `image-${fingerprint.slice(0, 24)}`, kind: 'image', name, file, fingerprint, streams: [] }, attachedPictureIndexes: [],
      image: inspectImageStream(stream, head!, file) };
  }
  const { streams, attachedPictureIndexes } = mediaStreamsFromProbe(data);
  if (!streams.length) throw new Error('映像または音声のストリームがありません');
  return { asset: { id: `media-${fingerprint.slice(0, 24)}`, kind: 'media', name, file, fingerprint, streams }, attachedPictureIndexes };
}

export interface PreparedAudioFile { file: string; sampleRate: number; channels: 2; sampleCount: number; rate: Rational }
// Separate result contract: window PCM is not ready for the legacy mixer.
export { prepareSequenceSourceWindowAudio } from './sourceWindowAudio';
export type { SourceWindowAudioRequest, PreparedSourceWindowAudio } from './sourceWindowAudio';
const preparations = new SharedPreparations<PreparedAudioFile>();

/** Pure gain/fade/ducking remain in the shared mixer; this only prepares source PCM. */
export async function prepareSequenceAudio(projectDirectory: string, asset: SequenceAsset, streamIndex: number, rate: Rational, signal?: AbortSignal): Promise<PreparedAudioFile> {
  signal?.throwIfAborted();
  if (!asset.streams.some(s => s.index === streamIndex && s.kind === 'audio') || compareTime(rate, rational(0)) <= 0) throw new Error('音声ストリームまたは速度が不正です');
  const caller=await openSequenceAsset(projectDirectory,asset,signal);
  try {
  const info = await caller.handle.stat();
  const normalized = rational(rate.num, rate.den);
  const key = createHash('sha256').update(JSON.stringify([asset.fingerprint, streamIndex, normalized, info.size, isSequenceReferenceFile(asset.file)?0:info.mtimeMs, 'pcm-v1-48000-stereo'])).digest('hex');
  const directory = await cacheDirectory(projectDirectory, 'audio'), destination = join(directory, `${key}.f32le`);
  const result=await preparations.get(destination, async preparationSignal => {
    preparationSignal.throwIfAborted();
    // Shared work owns a separate lease: cancelling its first caller cannot close this FD.
    const source=await openSequenceAsset(projectDirectory,asset,preparationSignal);
    try {
    try {
      const metadata = JSON.parse(await readFile(destination + '.json', 'utf8')) as PreparedAudioFile;
      const saved = await lstat(destination);
      if (saved.isSymbolicLink() || !saved.isFile()) throw new Error('音声キャッシュが通常のファイルではありません');
      if (saved.size === metadata.sampleCount * 8 && Number.isSafeInteger(metadata.sampleCount) && metadata.sampleCount > 0
        && metadata.sampleRate === 48000 && metadata.channels === 2 && isRational(metadata.rate) && compareTime(metadata.rate, normalized) === 0) {await source.verify();return { ...metadata, file: destination };}
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
    const filters: string[] = [];
    let tempo = timeNumber(normalized);
    // A saved clip may be 16× and the monitor's JKL shuttle another 8×.
    if (tempo < .01 || tempo > 128) throw new Error('音声の再生速度は0.01〜128倍に対応しています');
    while (tempo > 2) { filters.push('atempo=2'); tempo /= 2; }
    while (tempo < .5) { filters.push('atempo=0.5'); tempo /= .5; }
    if (tempo !== 1) filters.push(`atempo=${tempo}`);
    const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    try {
      await run(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fd','3','-i', 'fd:', '-map', `0:${streamIndex}`, '-vn',
        ...(filters.length ? ['-af', filters.join(',')] : []), '-ac', '2', '-ar', '48000', '-f', 'f32le', temporary], preparationSignal,source.handle.fd);
      let size = (await stat(temporary)).size;
      // Very short sources at high monitor rates can be shorter than atempo's
      // final analysis window and produce no samples at all. Retry only that
      // empty result with a finite silent tail, then trim to the real source
      // duration. Normal PCM bytes and existing successful caches stay intact.
      if(size===0&&filters.length){
        const stream=asset.streams.find(s=>s.index===streamIndex&&s.kind==='audio')!;
        const count=ceilTime(multiplyTime(divideTime(stream.duration,normalized),rational(48000)));
        const retryFilters=[`apad=pad_dur=${Math.max(1,timeNumber(normalized)*.25)}`,...filters,'aresample=48000',`atrim=end_sample=${count}`];
        // fd: shares the underlying seek position with its parent. A second
        // decoder needs a fresh verified description, never an unverified path.
        await source.verify();
        const retry=await openSequenceAsset(projectDirectory,asset,preparationSignal);
        try{
          await run(ffmpeg.bin,['-hide_banner','-loglevel','error','-nostdin','-y','-fd','3','-i','fd:','-map',`0:${streamIndex}`,'-vn',
            '-af',retryFilters.join(','),'-ac','2','-ar','48000','-f','f32le',temporary],preparationSignal,retry.handle.fd);
          await retry.verify();
        }finally{await retry.close();}
        size=(await stat(temporary)).size;
      }
      if (size === 0 || size % 8 !== 0) throw new Error('準備した音声PCMの長さが不正です');
      const result: PreparedAudioFile = { file: destination, sampleRate: 48000, channels: 2, sampleCount: size / 8, rate: normalized };
      await publishSequenceAudio(temporary,destination,result,()=>source.verify(),preparationSignal);
      return result;
    } finally { await unlink(temporary).catch(() => undefined); }
    }finally{await source.close();}
  }, signal);
  await caller.verify();signal?.throwIfAborted();return result;
  }finally{await caller.close();}
}
