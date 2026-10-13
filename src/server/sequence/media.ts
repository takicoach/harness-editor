import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpegBin, resolveFfprobeBin } from '../resolveFfmpeg';
import type { MediaStream, SequenceAsset } from '../../core/sequence/model';
import { ceilTime, compareTime, divideTime, isRational, multiplyTime, rational, rationalFromDecimal, timeNumber, type Rational } from '../../core/sequence/time';
import { parseCube } from '../../preview/native/lut';
import { SharedPreparations } from './sharedPreparation';
import {lanePriority,withFfmpegSlot,type FfmpegLane,type FfmpegPriority} from './ffmpegGate';
import {openSequenceAsset,registeredSequenceAssets} from './assets';
import {isSequenceReferenceFile} from './references';
import { inspectImageStream, readImageHead, readImageHeadFromHandle, type ImageInspection } from './imageProbe';
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
export function run(binary: string, args: string[], signal?: AbortSignal, inputFd?:number, maxStdoutBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe',...(inputFd===undefined?[]:[inputFd])], signal });
    let stdout = '', stderr = '', failure:Error|undefined;
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => {
      stdout += text;
      if (stdout.length > maxStdoutBytes) { failure??=new Error('素材情報の応答が大きすぎます');child.kill(); }
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
/**
 * 素材の調査には2つの入口がある。中身の判定（下の ffprobeJson・probedContent・sequenceAssetOf）は共通で、違うのは「何を読むか」と「変更の見張り方」だけ。
 * - probeSequenceAssetSource: パスで読む（案件内の素材・コピー取り込み・移行）。全体のハッシュもここで取り、読み終えるまで大きさ・更新時刻が変わらないかを見る。
 * - probePinnedSequenceAsset: 開いた実体（FileHandle）を読む（参照取り込み）。全体のハッシュは呼び出し側が同じ handle で1回だけ取り、
 *   差し替えの見張り（開いた実体とパスの同一性）も呼び出し側が持つ（references.ts の inspectSource）。
 */
export async function probeSequenceAssetSource(path:string,file:string,name:string,signal?:AbortSignal):Promise<SequenceAssetProbe>{
  const before = await stat(path);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  const fingerprint = digest.digest('hex');
  const unchanged = async () => {
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('読み込み中に素材が変更されました');
  };
  if (/\.cube$/i.test(file)) {
    if (before.size > 64 * 1024 * 1024) throw new Error('LUTファイルは64 MiB以下にしてください');
    parseCube(await readFile(path, 'utf8'));
    await unchanged();
    return { asset: sequenceAssetOf('lut', fingerprint, file, name, []), attachedPictureIndexes: [] };
  }
  const image = IMAGE_FILE.test(file), data = await ffprobeJson(path, image, signal);
  // 画像の先頭（EXIF の向き）も読み終えてから変更を確かめる。中身の判定はその後（変更の知らせを「画像を読み取れません」より先に出す）。
  const head = image ? await readImageHead(path) : undefined;
  await unchanged();
  const content = await probedContent(data, image, file, async () => head!);
  return { asset: sequenceAssetOf(content.kind, fingerprint, file, name, content.streams), attachedPictureIndexes: content.attachedPictureIndexes,
    ...(content.image ? { image: content.image } : {}) };
}
export interface PinnedSequenceProbe { kind: 'image' | 'media'; streams: MediaStream[]; attachedPictureIndexes: number[]; image?: ImageInspection }
/** 開いた実体（fd 3）だけを ffprobe で調べる。全体のハッシュは取らない（呼び出し側が同じ handle で1回だけ取る）。参照素材は LUT を扱わない。 */
export async function probePinnedSequenceAsset(handle: FileHandle, file: string, signal?: AbortSignal): Promise<PinnedSequenceProbe> {
  const image = IMAGE_FILE.test(file);
  return probedContent(await ffprobeJson(handle, image, signal), image, file, () => readImageHeadFromHandle(handle));
}
/** probeSequenceAssetSource と同じ形（id・kind・streams）の素材にする。 */
export function pinnedSequenceAsset(probe: PinnedSequenceProbe, fingerprint: string, file: string, name: string): SequenceAsset {
  return sequenceAssetOf(probe.kind, fingerprint, file, name, probe.streams);
}
/** 素材の ID は種類と中身の指紋（先頭24桁）で決まる。どちらの入口でも同じ id・同じ項目順にする（台帳の JSON も同じになる）。 */
function sequenceAssetOf(kind: 'media' | 'image' | 'lut', fingerprint: string, file: string, name: string, streams: MediaStream[]): SequenceAsset {
  return { id: `${kind}-${fingerprint.slice(0, 24)}`, kind, name, file, fingerprint, streams };
}
/**
 * 参照（リンク）取り込みを断る理由: ffprobe が開いたファイル（fd:）を読めない。パスで読み直す道は作らない（開いた実体を調べる安全性を保つ）。
 * コピーは勧めない（音声の準備・文字起こしはコピーした素材も fd: で ffmpeg に渡すので、古い ffmpeg では結局使えない）。
 */
export const FFPROBE_FD_UNSUPPORTED = 'この ffmpeg は古いため、この素材を取り込めません。ffmpeg を新しくしてください';
/** `ffprobe -protocols` の「Input:」の欄（読める入力の一覧）。Output の欄は含めない。 */
export function inputProtocols(listing: string): string[] {
  const lines = listing.split(/\r?\n/).map(line => line.trim()), start = lines.indexOf('Input:'); if (start < 0) return [];
  const end = lines.indexOf('Output:', start + 1); return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
}
const fdSupport = new Map<string, Promise<boolean>>();
/**
 * ffprobe が「fd:」を読めるか。bin ごとに1回調べて覚える。読めない結果と調べられなかった結果は覚えない
 * （ffmpeg を新しくした後、エディターを開き直さずに通すため。読めない環境で参照を試すたびに一覧を1回取り直すだけ）。
 */
export function ffprobeReadsFd(bin: string): Promise<boolean> {
  const known = fdSupport.get(bin); if (known) return known;
  const check = run(bin, ['-hide_banner', '-protocols']).then(listing => inputProtocols(listing).includes('fd'));
  const forget = () => { if (fdSupport.get(bin) === check) fdSupport.delete(bin); };
  fdSupport.set(bin, check); void check.then(readsFd => { if (!readsFd) forget(); }, forget);
  return check;
}
/**
 * FFprobe でストリームと形式を読む。入力がパスならそのパスを、FileHandle なら fd 3 として子へ渡して「fd:」を読ませる
 * （呼び出し側が開いた実体そのものを調べるので、途中でパスが差し替えられても別の中身を読まない）。
 * fd: を読めない ffprobe では FileHandle の調査を FFPROBE_FD_UNSUPPORTED で断る（画像でも理由をまとめない）。一覧を取れない時は判定せず、下の調査の失敗に任せる。
 * 画像は1コマずつ復号して数える（壊れた画像でも FFprobe は寸法 0 のストリームを返すため。動く画像の判定にも使う）。
 * 画像の調査の失敗は「画像を読み取れません」にそろえる。中止はそのまま中止として返す。
 */
async function ffprobeJson(input: string | FileHandle, image: boolean, signal?: AbortSignal): Promise<ProbeResult> {
  const probe = resolveFfprobeBin(); if (!probe.ok) throw new Error(probe.message);
  const pinned = typeof input !== 'string';
  if (pinned && !await ffprobeReadsFd(probe.bin).catch(() => true)) throw new Error(FFPROBE_FD_UNSUPPORTED);
  const args = ['-v', 'error', ...(pinned ? ['-fd', '3'] : []), ...(image ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', pinned ? 'fd:' : input];
  try { return JSON.parse(await run(probe.bin, args, signal, pinned ? input.fd : undefined)); }
  catch (error) { if (!image || signal?.aborted) throw error; throw new Error('画像を読み取れません', { cause: error }); }
}
/**
 * 調査の結果を素材の中身にする。画像は最初の映像ストリームと先頭のバイト列（EXIF の向き）から寸法・コマ数を決め、streams は空にする。
 * 動画・音声は mediaStreamsFromProbe（表紙を除く）で、映像も音声も無ければ断る。readHead は画像で映像ストリームがある時だけ呼ぶ。
 */
async function probedContent(data: ProbeResult, image: boolean, file: string, readHead: () => Promise<Buffer>): Promise<PinnedSequenceProbe> {
  if (image) {
    const stream = data.streams.find(s => s.codec_type === 'video');
    if (!stream) throw new Error('画像を読み取れません');
    return { kind: 'image', streams: [], attachedPictureIndexes: [], image: inspectImageStream(stream, await readHead(), file) };
  }
  const { streams, attachedPictureIndexes } = mediaStreamsFromProbe(data);
  if (!streams.length) throw new Error('映像または音声のストリームがありません');
  return { kind: 'media', streams, attachedPictureIndexes };
}

export interface PreparedAudioFile { file: string; sampleRate: number; channels: 2; sampleCount: number; rate: Rational }
// Separate result contract: window PCM is not ready for the legacy mixer.
export { prepareSequenceSourceWindowAudio } from './sourceWindowAudio';
export type { SourceWindowAudioRequest, PreparedSourceWindowAudio } from './sourceWindowAudio';
const preparations = new SharedPreparations<PreparedAudioFile>();
/** 1倍の作り方（元の素材 → 48kHz・2ch の f32le）。変えると、波形・無音の判定・再生が共有する既存の1倍の保存がすべて作り直しになる。 */
const SOURCE_PCM_VERSION = 'pcm-v1-48000-stereo';
/**
 * 1倍以外の作り方: 同じ素材・同じストリームの1倍の保存を入力に、音程を保つ早回し（atempo）をかける。元の素材は読まない
 * （遅い媒体では速さを変えるたびに元の全体を読み直し、主素材1本で約1分かかっていた。2026-10-04）。
 * 元の素材から早回ししていた版（pcm-v1）の保存とは混ぜない。
 */
const STRETCHED_PCM_VERSION = 'pcm-v2-stretched-from-1x-48000-stereo';
/** 保存の名前を決める組。中身の指紋が同じでも、大きさ・更新時刻（参照素材は大きさだけ）が変われば別の保存にする。 */
interface AudioSource { projectDirectory: string; asset: SequenceAsset; streamIndex: number; size: number; mtimeMs: number; directory: string }
function audioCachePath(source: AudioSource, rate: Rational): { key: string; destination: string } {
  const version = compareTime(rate, rational(1)) === 0 ? SOURCE_PCM_VERSION : STRETCHED_PCM_VERSION;
  const key = createHash('sha256').update(JSON.stringify([source.asset.fingerprint, source.streamIndex, rate, source.size, source.mtimeMs, version])).digest('hex');
  return { key, destination: join(source.directory, `${key}.f32le`) };
}
/** 修正前の倍速の作り方（元の素材から早回し）の版。1倍の版と同じ文字列だが、1倍の保存は速度で見分けて消さない。 */
const LEGACY_STRETCHED_PCM_VERSION = 'pcm-v1-48000-stereo';
/** 音声の保存（PCM・メタデータ・波形の索引）の名前。片付けはこの形の通常のファイルにしか触らない。目印はこの形に合わない名前にする。 */
const AUDIO_CACHE_FILE = /^[0-9a-f]{64}\.f32le(\.json|\.waveform-v1)?$/;
const RETIRED_MARKER = '.retired-stretched-pcm-v1';
const retirements = new Map<string, Promise<void>>();
/** 試験用: プロセス内の「片付け済み」の記録を消す（サーバの再起動に相当）。 */
export function forgetAudioCacheRetirement(): void { retirements.clear(); }
/** 案件の音声キャッシュごとにプロセス内で1回だけ。失敗は記録するだけで、呼び手（再生の準備）には伝えない。 */
function retireSourceStretchedAudio(projectDirectory: string, directory: string): Promise<void> {
  let retirement = retirements.get(directory);
  if (!retirement) {
    retirement = retireSourceStretchedAudioOnce(projectDirectory, directory).catch(error => { console.warn('古い倍速の音声キャッシュを片付けられませんでした', error); });
    retirements.set(directory, retirement);
  }
  return retirement;
}
/**
 * 古い版（元の素材から早回しした）倍速の保存を消す。消すのは、メタデータの速度が1倍でなく、登録中の素材・音声ストリームについて
 * 旧キー sha256([指紋, ストリーム, 速度, 大きさ, 更新時刻|0, pcm-v1]) を今の stat で計算して名前と一致したもの（旧版の倍速と確定できるもの）だけ。
 * 1倍の保存と新しい版の倍速、リンク・名前の合わないファイル・登録外の素材の保存には触らない。消す順は PCM → 波形の索引 → メタデータ。
 * ENOENT 以外の失敗と、stat できない素材（つながっていない参照など）は記録して飛ばし、その時は目印を置かずに次の起動でやり直す。
 */
async function retireSourceStretchedAudioOnce(projectDirectory: string, directory: string): Promise<void> {
  const marker = join(directory, RETIRED_MARKER);
  try { if ((await lstat(marker)).isFile()) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let complete = true;
  const skipped = (target: string, error: unknown) => { complete = false; console.warn(`古い倍速の音声キャッシュの片付けを飛ばしました: ${target}`, error); };
  const sources: Array<{ fingerprint: string; streamIndex: number; size: number; mtimeMs: number }> = [];
  for (const asset of await registeredSequenceAssets(projectDirectory)) {
    const streams = asset.streams.filter(stream => stream.kind === 'audio');
    if (!streams.length) continue;
    const reference = isSequenceReferenceFile(asset.file);
    let info: Stats;
    try { info = await stat(reference ? join(projectDirectory, asset.file) : await managedAssetPath(projectDirectory, asset.file)); }
    catch (error) { skipped(asset.file, error); continue; }
    for (const stream of streams) sources.push({ fingerprint: asset.fingerprint, streamIndex: stream.index, size: info.size, mtimeMs: reference ? 0 : info.mtimeMs });
  }
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.f32le.json') || !AUDIO_CACHE_FILE.test(name)) continue;
    const key = name.slice(0, 64);
    let rate: Rational;
    try {
      if (!(await lstat(join(directory, name))).isFile()) continue;
      const metadata = JSON.parse(await readFile(join(directory, name), 'utf8')) as { rate?: unknown } | null;
      if (!isRational(metadata?.rate)) continue;
      rate = rational(metadata.rate.num, metadata.rate.den);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) skipped(name, error); continue; }
    if (compareTime(rate, rational(1)) === 0) continue;
    if (!sources.some(source => createHash('sha256').update(JSON.stringify([source.fingerprint, source.streamIndex, rate, source.size, source.mtimeMs, LEGACY_STRETCHED_PCM_VERSION])).digest('hex') === key)) continue;
    const files = [`${key}.f32le`, `${key}.f32le.waveform-v1`, `${key}.f32le.json`];
    try {
      // どれか1つでも通常のファイルでない（リンクなど）組は丸ごと残す。
      let regular = true;
      for (const file of files) {
        try { if (!AUDIO_CACHE_FILE.test(file) || !(await lstat(join(directory, file))).isFile()) regular = false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!regular) continue;
    } catch (error) { skipped(name, error); continue; }
    // 失敗したらその組の残り（最後のメタデータを含む）は消さない。メタデータが残れば次の起動で同じ組と分かる。
    for (const file of files) {
      try { await unlink(join(directory, file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped(file, error); break; } }
    }
  }
  if (complete) await writeFile(marker, 'pcm-v1 の倍速の保存は片付け済み\n', { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
}
/** 保存済みの PCM。リンク・通常のファイルでないものは断り、長さ・形式・速度が合わないもの（途中で切れた・メタデータが壊れた）は無いものとして作り直す。 */
async function savedAudio(destination: string, rate: Rational): Promise<PreparedAudioFile | undefined> {
  try {
    const metadata = JSON.parse(await readFile(destination + '.json', 'utf8')) as PreparedAudioFile;
    const saved = await lstat(destination);
    if (saved.isSymbolicLink() || !saved.isFile()) throw new Error('音声キャッシュが通常のファイルではありません');
    if (saved.size === metadata.sampleCount * 8 && Number.isSafeInteger(metadata.sampleCount) && metadata.sampleCount > 0
      && metadata.sampleRate === 48000 && metadata.channels === 2 && isRational(metadata.rate) && compareTime(metadata.rate, rate) === 0) return { ...metadata, file: destination };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return undefined;
}
/** 音程を保つ早回し。atempo は1段 0.5〜2倍なので段を重ねる。 */
function tempoFilters(rate: Rational): string[] {
  const filters: string[] = [];
  let tempo = timeNumber(rate);
  // A saved clip may be 16× and the monitor's JKL shuttle another 8×.
  if (tempo < .01 || tempo > 128) throw new Error('音声の再生速度は0.01〜128倍に対応しています');
  while (tempo > 2) { filters.push('atempo=2'); tempo /= 2; }
  while (tempo < .5) { filters.push('atempo=0.5'); tempo /= .5; }
  if (tempo !== 1) filters.push(`atempo=${tempo}`);
  return filters;
}

/** Pure gain/fade/ducking remain in the shared mixer; this only prepares source PCM. */
export async function prepareSequenceAudio(projectDirectory: string, asset: SequenceAsset, streamIndex: number, rate: Rational, signal?: AbortSignal, priority: FfmpegPriority = 'audio'): Promise<PreparedAudioFile> {
  signal?.throwIfAborted();
  if (!asset.streams.some(s => s.index === streamIndex && s.kind === 'audio') || compareTime(rate, rational(0)) <= 0) throw new Error('音声ストリームまたは速度が不正です');
  const normalized = rational(rate.num, rate.den), filters = compareTime(normalized, rational(1)) === 0 ? undefined : tempoFilters(normalized);
  // 呼び手ごとの照合: 元の素材が今も保存時の中身（指紋）のままであること。保存の名前はこの指紋で決まるので、1倍の保存もこの中身から作ったものに限られる。
  const caller=await openSequenceAsset(projectDirectory,asset,signal);
  try {
  const info = await caller.handle.stat();
  const directory = await cacheDirectory(projectDirectory, 'audio');
  // 案件ごとにプロセス内で1回だけ、最初の準備の前に古い版の倍速の保存を片付ける（失敗しても準備は止めない）。
  await retireSourceStretchedAudio(projectDirectory, directory);
  const source: AudioSource = { projectDirectory, asset, streamIndex, size: info.size, mtimeMs: isSequenceReferenceFile(asset.file) ? 0 : info.mtimeMs, directory };
  const result = filters ? await prepareStretchedAudio(source, normalized, filters, signal, priority) : await prepareSourceAudio(source, signal, priority);
  await caller.verify();signal?.throwIfAborted();return result;
  }finally{await caller.close();}
}

/** 1倍: 元の素材から作る（作り方・保存の名前は修正前のまま）。 */
function sourcePreparationKey(source: AudioSource, rebuild: boolean): string { return audioCachePath(source, rational(1)).destination + (rebuild ? '#rebuild' : ''); }
/** rebuild: 保存済みの1倍を使わずに元の素材から作り直し、新しい保存で置き換える（読んでいる間に変わった1倍を再利用しないため）。 */
function prepareSourceAudio(source: AudioSource, signal: AbortSignal | undefined, priority: FfmpegPriority, rebuild = false): Promise<PreparedAudioFile> {
  const one = rational(1), { key, destination } = audioCachePath(source, one);
  return preparations.get(sourcePreparationKey(source, rebuild), async (preparationSignal, lane) => {
    preparationSignal.throwIfAborted();
    // Shared work owns a separate lease: cancelling its first caller cannot close this FD.
    const lease = await openSequenceAsset(source.projectDirectory, source.asset, preparationSignal);
    try {
      const saved = rebuild ? undefined : await savedAudio(destination, one);
      if (saved) { await lease.verify(); return saved; }
      const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
      const temporary = join(source.directory, `${key}.${randomUUID()}.tmp`);
      try {
        await withFfmpegSlot(lane, preparationSignal, () => run(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fd', '3', '-i', 'fd:', '-map', `0:${source.streamIndex}`, '-vn',
          '-ac', '2', '-ar', '48000', '-f', 'f32le', temporary], preparationSignal, lease.handle.fd));
        const size = (await stat(temporary)).size;
        if (size === 0 || size % 8 !== 0) throw new Error('準備した音声PCMの長さが不正です');
        const result: PreparedAudioFile = { file: destination, sampleRate: 48000, channels: 2, sampleCount: size / 8, rate: one };
        await publishSequenceAudio(temporary, destination, result, () => lease.verify(), preparationSignal);
        return result;
      } finally { await unlink(temporary).catch(() => undefined); }
    } finally { await lease.close(); }
  }, signal, priority);
}

/** 1倍の作成を待っている倍速の準備（保存先の名前 → 待っている1倍の準備の名前）。 */
const waitingForSource = new Map<string, string>();
/** 1倍以外: 1倍の保存から作る。1倍の保存が無ければ、先に1倍を今の作り方で作る（1倍の共有の準備・実行枠に乗る）。 */
function prepareStretchedAudio(source: AudioSource, rate: Rational, filters: string[], signal: AbortSignal | undefined, priority: FfmpegPriority): Promise<PreparedAudioFile> {
  const { key, destination } = audioCachePath(source, rate);
  const result = preparations.get(destination, async (preparationSignal, lane) => {
    preparationSignal.throwIfAborted();
    const saved = await savedAudio(destination, rate);
    if (saved) return saved;
    for (let attempt = 0; ; attempt++) {
      // この準備の取り消しは1倍の待ちにも届く（1倍を待つ他の呼び手がいなければ1倍の作成も止まる）。順位はこの準備の今の順位で合流する。
      // 読む直前・読んでいる間に1倍の保存が消えた・変わった後の1回だけは、その保存を再利用せず元の素材から作り直す
      // （大きさが同じ書き換えはメタデータの照合では見つからない）。作り直した1倍も変わったら、その要求は失敗させる。
      const rebuild = attempt > 0;
      waitingForSource.set(destination, sourcePreparationKey(source, rebuild));
      let base: PreparedAudioFile;
      try { base = await prepareSourceAudio(source, preparationSignal, lanePriority(lane), rebuild); } finally { waitingForSource.delete(destination); }
      try { return await stretchSavedAudio(base, source, key, destination, rate, filters, lane, preparationSignal); }
      catch (error) { if (attempt || !(error instanceof SavedAudioChanged)) throw error; }
    }
  }, signal, priority);
  // 後から合流した急ぐ呼び手（再生）は、この準備が1倍を待っている時だけ、その1倍の作成も急がせる（倍速の保存があれば1倍には触らない）。
  const waiting = waitingForSource.get(destination);
  if (waiting) preparations.raise(waiting, priority);
  return result;
}

class SavedAudioChanged extends Error {}
interface SavedAudioLease { handle: FileHandle; identity: string; verify(): Promise<void>; close(): Promise<void> }
/** 1倍の保存をリンクをたどらずに開き、準備の結果どおりの通常のファイル（同じ長さ・今もその名前のファイル）かを確かめる。verify は読み終えた後も中身が同じか（識別・大きさ・更新時刻）。 */
async function openSavedAudio(base: PreparedAudioFile): Promise<SavedAudioLease> {
  const changed = (error?: unknown) => new SavedAudioChanged('1倍の音声キャッシュが変更されました', { cause: error });
  const vanished = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' ? changed(error) : error;
  let handle: FileHandle;
  try { handle = await open(base.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw vanished(error); }
  try {
    const identity = (info: Stats) => JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs]);
    const opened = await handle.stat(), named = await lstat(base.file).catch(error => { throw vanished(error); });
    if (!opened.isFile() || opened.size !== base.sampleCount * 8 || named.dev !== opened.dev || named.ino !== opened.ino) throw changed();
    return { handle, identity: identity(opened), close: () => handle.close(),
      verify: async () => { if (identity(await handle.stat()) !== identity(opened)) throw changed(); } };
  } catch (error) { await handle.close(); throw error; }
}
async function stretchSavedAudio(base: PreparedAudioFile, source: AudioSource, key: string, destination: string, rate: Rational, filters: string[], lane: FfmpegLane, signal: AbortSignal): Promise<PreparedAudioFile> {
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const temporary = join(source.directory, `${key}.${randomUUID()}.tmp`);
  // 入力は1倍の保存（48kHz・2ch の f32le）。出力の形式は1倍と同じ。
  const stretch = (input: SavedAudioLease, chain: string[]) => withFfmpegSlot(lane, signal, () => run(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-fd', '3', '-i', 'fd:', '-map', '0:0', '-af', chain.join(','), '-ac', '2', '-ar', '48000', '-f', 'f32le', temporary], signal, input.handle.fd));
  const saved = await openSavedAudio(base);
  try {
    await stretch(saved, filters);
    let size = (await stat(temporary)).size;
    // Very short sources at high monitor rates can be shorter than atempo's
    // final analysis window and produce no samples at all. Retry only that
    // empty result with a finite silent tail, then trim to the real source
    // duration. Normal PCM bytes stay intact.
    if (size === 0) {
      const stream = source.asset.streams.find(s => s.index === source.streamIndex && s.kind === 'audio')!;
      const count = ceilTime(multiplyTime(divideTime(stream.duration, rate), rational(48000)));
      // fd: shares the read position with the first run; the retry reads a fresh descriptor of the same saved file.
      const again = await openSavedAudio(base);
      try {
        if (again.identity !== saved.identity) throw new SavedAudioChanged('1倍の音声キャッシュが変更されました');
        await stretch(again, [`apad=pad_dur=${Math.max(1, timeNumber(rate) * .25)}`, ...filters, 'aresample=48000', `atrim=end_sample=${count}`]);
        await again.verify();
      } finally { await again.close(); }
      size = (await stat(temporary)).size;
    }
    if (size === 0 || size % 8 !== 0) throw new Error('準備した音声PCMの長さが不正です');
    const result: PreparedAudioFile = { file: destination, sampleRate: 48000, channels: 2, sampleCount: size / 8, rate };
    await publishSequenceAudio(temporary, destination, result, () => saved.verify(), signal);
    return result;
  } finally { await saved.close(); await unlink(temporary).catch(() => undefined); }
}
