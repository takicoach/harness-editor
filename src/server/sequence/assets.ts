import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import type { MediaStream, SequenceAsset } from '../../core/sequence/model';
import { probeSequenceAsset, managedAssetPath } from './media';
import type { ImageInspection } from './imageProbe';
import { validateSequenceDocument } from '../../core/sequence/validate';
import {isSequenceReferenceFile,openSequenceReference,registeredSequenceReferences} from './references';
import {assertStillResolved,SOURCE_MOVED_MESSAGE,type ImportSourceOptions} from './sourceCheck';
import {FileChangedError,fileIdentity,sharedFileDigest,sharedFileDigestUntilStalled} from './sharedDigest';
import {watchedFs,type ReadLimit} from './fsWatch';

export interface RegisteredSequenceAsset { asset: SequenceAsset; image?: ImageInspection }
/** 取り込みの束へ段を知らせる（設計 §2-5）。知らせるだけで、照合の手順・順序は変えない。 */
export interface ImportHooks { onPhase?(phase: 'probing' | 'fingerprinting'): void; onProbed?(streams: readonly MediaStream[]): void }

/** Old registrations may retain an attached cover stream; preserve them only when every other stream matches. */
export function onlyAttachedPicturesDiffer(recorded: readonly MediaStream[], current: readonly MediaStream[], attachedPictureIndexes: readonly number[]): boolean {
  const extra = recorded.filter(stream => stream.kind === 'video' && attachedPictureIndexes.includes(stream.index));
  if (!extra.length) return false;
  return isDeepStrictEqual(recorded.filter(stream => !extra.includes(stream)), current);
}

/** A caller has already authorized the source path (upload or resolved project asset). */
export async function importSequenceAsset(projectDirectory: string, sourcePath: string, name = basename(sourcePath), signal?: AbortSignal): Promise<SequenceAsset> {
  return (await importSequenceAssetDetailed(projectDirectory, sourcePath, name, signal)).asset;
}
export async function importSequenceAssetDetailed(projectDirectory: string, sourcePath: string, name = basename(sourcePath), signal?: AbortSignal, hooks?: ImportHooks, options?: ImportSourceOptions): Promise<RegisteredSequenceAsset> {
  await assertStillResolved(sourcePath, options);
  const root = await realpath(projectDirectory), source = await realpath(sourcePath), before = await stat(source);
  if (options?.resolvedSource && source !== sourcePath) throw new Error(SOURCE_MOVED_MESSAGE);
  if (!before.isFile()) throw new Error('取り込む素材が通常のファイルではありません');
  const extension = (extname(name) || extname(sourcePath)).toLowerCase();
  if (!/^\.(mp4|mov|m4v|mkv|webm|avi|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|avif|bmp|cube)$/.test(extension)) throw new Error('未対応の素材形式です');
  let directory = root;
  for (const segment of ['.harness', 'assets']) {
    directory = join(directory, segment); await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('素材の保存先が不正です');
  }
  const temporary = join(directory, `${randomUUID()}${extension}`), digest = createHash('sha256');
  const same = (info: Stats) => info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs;
  try {
    // リンクをたどらずに開き、開いたファイルが上で確かめたものと同じか（dev・ino・大きさ・更新時刻）を照合して、そのファイルから読む（パスを開き直さない）。
    // 確かめた後・開く前だけ別のファイルに差し替えて、読み終えてから戻す経路も、開いたファイルの照合で断る。
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(await sourceHandle.stat())) throw new Error('取り込み中に元の素材が変更されました');
      hooks?.onPhase?.('fingerprinting');
      await pipeline(sourceHandle.createReadStream({ autoClose: false, start: 0 }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk); callback(null, chunk);
      } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (!same(await sourceHandle.stat()) || !same(await stat(source))) throw new Error('取り込み中に元の素材が変更されました');
    } finally { await sourceHandle.close(); }
    // 受付時に実パスへ解決した素材は、読んだ後にも今も同じ実パスかを確かめる（途中のフォルダをリンクへ差し替えたままの経路を断る）。
    await assertStillResolved(sourcePath, options);
    const fingerprint = digest.digest('hex');
    // Probe before publication; invalid files cannot become registered assets.
    hooks?.onPhase?.('probing');
    const probed = await probeSequenceAsset(root, `.harness/assets/${basename(temporary)}`, name, signal), inspected = probed.asset;
    hooks?.onProbed?.(probed.asset.streams);
    if (inspected.fingerprint !== fingerprint) throw new Error('取り込んだ素材の内容が一致しません');
    const handle = await open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const file = `.harness/assets/${fingerprint}${extension}`, destination = join(root, file);
    try { await link(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const asset = { ...inspected, file };
    await verifiedSequenceAssetPath(root, asset, signal);
    const metaTemporary = temporary + '.json', metadata = destination + '.json';
    const metadataHandle = await open(metaTemporary, 'wx', 0o600);
    let result: SequenceAsset = asset;
    try {
      await metadataHandle.writeFile(JSON.stringify({ format: 'harness-asset', version: 1, asset }) + '\n');
      await metadataHandle.sync(); await metadataHandle.close();
      try { await link(metaTemporary, metadata); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const recorded = await readRegisteredAsset(root, metadata);
      if (recorded.file !== asset.file || recorded.fingerprint !== asset.fingerprint) throw new Error('素材の登録情報が変更されています');
      if (JSON.stringify(recorded.streams) !== JSON.stringify(asset.streams)) {
        if (!onlyAttachedPicturesDiffer(recorded.streams, asset.streams, probed.attachedPictureIndexes)) throw new Error('素材の登録情報が変更されています');
        result = recorded;
      }
    } finally { await metadataHandle.close().catch(() => undefined); await unlink(metaTemporary).catch(() => undefined); }
    if (process.platform !== 'win32') { const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
    return { asset: result, ...(probed.image ? { image: probed.image } : {}) };
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function readRegisteredAsset(root: string, metadata: string): Promise<SequenceAsset> {
  const info = await lstat(metadata);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('素材の登録情報が不正です');
  const value = JSON.parse(await readFile(metadata, 'utf8')) as { format?: unknown; version?: unknown; asset?: SequenceAsset };
  if (value.format !== 'harness-asset' || value.version !== 1 || !value.asset) throw new Error('素材の登録情報が不正です');
  const asset = value.asset;
  if (join(root, asset.file) + '.json' !== metadata || !/^[a-f0-9]{64}$/.test(asset.fingerprint)
    || basename(asset.file).split('.')[0] !== asset.fingerprint) throw new Error('素材の登録先が一致しません');
  validateSequenceDocument({ schemaVersion: 2, id: 'registry', name: '素材台帳', revision: 0, fps: { num: 1, den: 1 },
    resolution: { width: 1, height: 1 }, sequenceEndFrame: 0, background: '#000000', assets: [asset],
    tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } });
  return asset;
}

/** Includes successfully imported but still unreferenced assets after a failed document save. */
export async function registeredSequenceAssets(projectDirectory: string): Promise<SequenceAsset[]> {
  const root = await realpath(projectDirectory), assets: SequenceAsset[] = [];
  let managedExists=true;
  for (const segment of ['.harness', '.harness/assets']) {
    try { const info = await lstat(join(root, segment)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('素材台帳の保存先が不正です'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {managedExists=false;break;} throw error; }
  }
  for (const name of managedExists?(await readdir(join(root, '.harness/assets'))).sort():[]) {
    if (!/^[a-f0-9]{64}\.[a-z0-9]+\.json$/.test(name)) continue;
    const asset = await readRegisteredAsset(root, join(root, '.harness/assets', name));
    if (!assets.some(a => a.id === asset.id)) assets.push(asset);
  }
  for(const asset of await registeredSequenceReferences(root))if(!assets.some(item=>item.id===asset.id))assets.push(asset);
  return assets;
}

/** Record an audio fix's lineage on an already-registered asset. Only the registry JSON changes; the media bytes never do. */
export async function registerAssetOrigin(
  projectDirectory: string, assetId: string, origin: NonNullable<SequenceAsset['origin']>,
): Promise<SequenceAsset> {
  const root = await realpath(projectDirectory);
  const asset = (await registeredSequenceAssets(root)).find(item => item.id === assetId);
  if (!asset) throw new Error('由来を記録する素材が見つかりません');
  const metadata = join(root, asset.file) + '.json', temporary = `${metadata}.${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ format: 'harness-asset', version: 1, asset: { ...asset, origin } }) + '\n');
    await handle.sync();
  } finally { await handle.close().catch(() => undefined); }
  try { await rename(temporary, metadata); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return readRegisteredAsset(root, metadata);
}

// Cache only successful full hashes; a changed inode/ctime/mtime/size invalidates it.
const verified = new Map<string, string>();
export async function verifiedSequenceAssetPath(projectDirectory: string, asset: SequenceAsset, signal?: AbortSignal): Promise<string> {
  if(isSequenceReferenceFile(asset.file)){const lease=await openSequenceReference(projectDirectory,asset,signal);try{return lease.path;}finally{await lease.close();}}
  if (!/^[a-f0-9]{64}$/.test(asset.fingerprint)) throw new Error('素材の指紋が不正です');
  const path = await managedAssetPath(projectDirectory, asset.file), before = await stat(path);
  if ((await lstat(join(projectDirectory, asset.file))).isSymbolicLink()) throw new Error('管理素材がシンボリックリンクに置き換わっています');
  const signature = JSON.stringify([asset.fingerprint, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  if (verified.get(path) === signature) return path;
  const changed = () => new Error(`素材「${asset.name}」が変更されています。保存時の素材を復元してください`);
  let digest: string;
  try { digest = await sharedFileDigest(path, fileIdentity(before), signal); }
  catch (error) { if (error instanceof FileChangedError) throw changed(); throw error; }
  if (digest !== asset.fingerprint || fileIdentity(await stat(path)) !== fileIdentity(before)) throw changed();
  verified.set(path, signature);
  while (verified.size > 128) verified.delete(verified.keys().next().value!);
  return path;
}

export interface SequenceAssetLease {
  path:string;handle:Awaited<ReturnType<typeof open>>;verify():Promise<void>;close():Promise<void>;
}
/** Pin the verified file for consumers that would otherwise reopen a mutable path.
 * limit.unresponsiveMs (書き出し前の確認): 開く・確かめる処理が戻らない時、読みが進まない時にその長さで待つのをやめる（UnresponsiveFileError）。 */
export async function openSequenceAsset(projectDirectory:string,asset:SequenceAsset,signal?:AbortSignal,limit:ReadLimit={}):Promise<SequenceAssetLease>{
  if(isSequenceReferenceFile(asset.file))return openSequenceReference(projectDirectory,asset,signal,limit);
  if(!/^[a-f0-9]{64}$/.test(asset.fingerprint))throw new Error('素材の指紋が不正です');
  const path=await managedAssetPath(projectDirectory,asset.file),limitMs=limit.unresponsiveMs;
  if((await lstat(join(projectDirectory,asset.file))).isSymbolicLink())throw new Error('管理素材がシンボリックリンクに置き換わっています');
  const handle=await watchedFs('open',path,()=>open(path,'r'),{limitMs,dispose:late=>late.close()});let closed=false;
  const close=async()=>{if(!closed){closed=true;await handle.close();}};
  try{
    const before=await handle.stat();
    const identity=(value:typeof before)=>JSON.stringify([value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs]);
    const signature=JSON.stringify([asset.fingerprint,before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs]);
    const verify=async()=>{
      signal?.throwIfAborted();
      if(closed||identity(await handle.stat())!==identity(before)||identity(await watchedFs('stat',path,()=>stat(path),{limitMs}))!==identity(before)
        ||(await lstat(join(projectDirectory,asset.file))).isSymbolicLink())throw new Error('読み取り中に素材が変更されました');
    };
    if(verified.get(path)!==signature){
      // The shared digest opens its own descriptor and proves it is this same file (dev/ino/size/mtime/ctime).
      let digest:string;
      try{digest=await (limitMs===undefined?sharedFileDigest(path,fileIdentity(before),signal):sharedFileDigestUntilStalled(path,fileIdentity(before),signal,limitMs));}
      catch(error){if(error instanceof FileChangedError)throw new Error('読み取り中に素材が変更されました');throw error;}
      if(digest!==asset.fingerprint)throw new Error('保存時の素材と内容が一致しません');
      await verify();verified.set(path,signature);while(verified.size>128)verified.delete(verified.keys().next().value!);
    }
    await verify();return {path,handle,verify,close};
  }catch(error){await close();throw error;}
}
