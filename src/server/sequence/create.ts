import { mkdir, rm, lstat, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeProjectName, precheckCreateProject, precheckCreateImages } from '../projectCreationChecks';
import { HttpError } from '../http';
import { importSequenceAssetDetailed, type RegisteredSequenceAsset } from './assets';
import { registerSequenceReferenceDetailed } from './references';
import { SequenceStore } from './store';
import { buildAudioDocument, buildImageDocument, buildVideoDocument, type ImagePlacement } from './createDocuments';
import { imageLimitMessage, MAX_CREATE_IMAGES } from '../../shared/createMedia';
import type { SequenceDocument } from '../../core/sequence/model';
import type { ImageDisplaySize } from './imageProbe';

/**
 * 作成のフォルダを1つ確保し、文書を1回だけ保存して確定する。途中で失敗・中止したら、
 * この要求が作った未確定のフォルダだけを消す（確定後の失敗や、入れ替わったフォルダは残す）。
 */
async function createInOwnedDirectory(root: string, rawName: string, precheck: (parent: string, id: string) => void, signal: AbortSignal | undefined,
  build: (directory: string, id: string) => Promise<SequenceDocument>): Promise<{ id: string }> {
  const parent = await realpath(root), id = sanitizeProjectName(rawName);
  precheck(parent, id); signal?.throwIfAborted();
  const directory = join(parent, id);
  try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '同じ名前のプロジェクトがすでにあります'); throw error; }
  const owned = await lstat(directory);
  try {
    const document = await build(directory, id);
    signal?.throwIfAborted();
    new SequenceStore(directory).save({ document, expectedSavedRevision: null, executionId: randomUUID() });
    return { id };
  } catch (error) {
    // A failure after the atomic rename is an unknown commit. Preserve its document for recovery.
    const committed = await lstat(join(directory, '.harness/project.v2.json')).then(() => true, () => false);
    // Remove only this request's uncommitted directory, never an existing/replaced project.
    const current = await lstat(directory).catch(() => null);
    if (!committed && current?.isDirectory() && !current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const animatedImage = (name: string) => new HttpError(422, `「${name}」は動く画像です。動く画像にはまだ対応していません`);
function unreadableImage(name: string, error: unknown): unknown {
  return error instanceof Error && error.message === '画像を読み取れません' ? new HttpError(422, `「${name}」を画像として読み取れません。別の画像を選んでください`) : error;
}

/** 1件の素材の中身で作品の種類を決める（映像があれば動画、無ければ音声、画像の拡張子なら画像）。 */
function singleSourceDocument(id: string, registered: RegisteredSequenceAsset): SequenceDocument {
  const { asset, image } = registered;
  if (asset.kind === 'image') {
    if (image?.animated) throw animatedImage(asset.name);
    return buildImageDocument(id, [{ asset, name: asset.name }], image?.displaySize);
  }
  if (asset.kind !== 'media') throw new HttpError(422, '動画・音声・画像のファイルを選んでください');
  if (asset.streams.some(stream => stream.kind === 'video')) return buildVideoDocument(id, asset);
  if (asset.streams.some(stream => stream.kind === 'audio')) return buildAudioDocument(id, asset);
  throw new HttpError(422, '映像か音声のあるファイルを選んでください');
}

/** Source path has already passed upload/browse authority. No legacy templates or package install. */
export async function createSequenceProject(root: string, input: { name:string;videoName:string;sourcePath:string;reference?:boolean;expectedFingerprint?:string }, signal?:AbortSignal): Promise<{ id:string }> {
  if(input.expectedFingerprint!==undefined&&!input.reference)throw new HttpError(400,'素材の指紋指定は参照作成に必要です');
  const name = basename(input.videoName);
  return createInOwnedDirectory(root, input.name, (parent, id) => precheckCreateProject(parent, id, input.videoName), signal, async (directory, id) => {
    let registered: RegisteredSequenceAsset;
    try {
      registered = await (input.reference ? registerSequenceReferenceDetailed(directory, input.sourcePath, name, signal, input.expectedFingerprint)
        : importSequenceAssetDetailed(directory, input.sourcePath, name, signal));
    } catch (error) { throw unreadableImage(name, error); }
    return singleSourceDocument(id, registered);
  });
}

/** 複数画像を全件検査してから、1つの作品として保存する。sourcePath は呼び出し側が認可済み。 */
export async function createSequenceImageProject(root: string, input: { name: string; images: ReadonlyArray<{ name: string; sourcePath: string }> }, signal?: AbortSignal): Promise<{ id: string }> {
  const names = input.images.map(image => basename(image.name));
  return createInOwnedDirectory(root, input.name, (parent, id) => precheckCreateImages(parent, id, names), signal, async (directory, id) => {
    let total = 0;
    for (const image of input.images) total += (await stat(image.sourcePath)).size;
    const limit = imageLimitMessage(input.images.length, total);
    if (limit) throw new HttpError(input.images.length > MAX_CREATE_IMAGES ? 400 : 413, limit);
    const placements: ImagePlacement[] = [];
    let display: ImageDisplaySize | undefined;
    for (const [index, image] of input.images.entries()) {
      signal?.throwIfAborted();
      const name = names[index]!;
      let registered: RegisteredSequenceAsset;
      try { registered = await importSequenceAssetDetailed(directory, image.sourcePath, name, signal); }
      catch (error) { throw unreadableImage(name, error); }
      if (registered.image?.animated) throw animatedImage(name);
      if (index === 0) display = registered.image?.displaySize;
      placements.push({ asset: placements.find(item => item.asset.id === registered.asset.id)?.asset ?? registered.asset, name });
    }
    return buildImageDocument(id, placements, display);
  });
}
