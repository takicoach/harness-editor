import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadProject } from '../../core/project';
import type { SequenceAsset } from '../../core/sequence/model';
import { migrateLegacySequence, type LegacyAssetBindings, type LegacyMigrationResult } from '../../core/sequence/migrateLegacy';
import {migrateLegacyWithCutHistory} from '../../core/sequence/migrateLegacyWithCutHistory';
import { SequenceError } from '../../core/sequence/errors';
import { readProjectFiles } from '../loadProjectFiles';
import { resolvePublicAsset } from '../projectRoot';
import { HttpError } from '../http';
import { inspectVideoLink, readVideoLink } from '../videoLink';
import { freezeSequenceComponent } from './components';
import { importSequenceAsset } from './assets';
import { openSequenceReference, reconnectSequenceReference, registeredSequenceReferences, registerSequenceReference } from './references';
import { inspectSequenceAssetSource, managedAssetPath } from './media';
import { SequenceStore, type SaveSequenceResult } from './store';
import { assertLegacySequenceAuthority } from './authority';
import { legacyPreviewReferences, type LegacyPreviewReferences, type LegacyPreviewCatalog } from '../../core/sequence/legacyPreview';

/** Content-only legacy fingerprint; reading it never executes TSX or creates baselines.
 * Keep the historical algorithm: existing native documents compare against it. */
export async function legacyInputFingerprint(directory: string): Promise<string> {
  const files = ['cutData.ts', 'transcript.json', 'shooting-script.json', 'editor-timeline.json', 'project-config.json'];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink() && (await stat(join(directory, path))).isDirectory()) throw new Error('リンクされた編集部品フォルダーは先に案件内へコピーしてください');
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:[cm]?[jt]sx?|json)$/i.test(entry.name)) files.push(path);
    }
  };
  await walk('src');
  const digest = createHash('sha256'); let total = 0;
  for (const file of files.sort()) {
    let path: string;
    try { path = await managedAssetPath(directory, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { digest.update(JSON.stringify([file, null])); continue; } throw error; }
    const size = (await stat(path)).size; total += size;
    if (size > 16 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error('移行する編集データが大きすぎます');
    digest.update(JSON.stringify([file, createHash('sha256').update(await readFile(path)).digest('hex')]));
  }
  return digest.digest('hex');
}

/** Transaction admission only; never replace the saved historical fingerprint. */
async function legacyLinkFingerprint(directory: string): Promise<string | null> {
  let path: string;
  try { path = await managedAssetPath(directory, '.sme/videoLink.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if ((await stat(path)).size > 128 * 1024) throw new Error('リンク元の接続記録が大きすぎます');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export interface MigrationResult extends SaveSequenceResult { notices: string[] }
/** Caller resolves the project. Original data/assets stay untouched; v2 is committed last. */
export async function migrateSequenceProject(directory: string, executionId: string, signal?: AbortSignal): Promise<MigrationResult> {
  signal?.throwIfAborted();
  const store = new SequenceStore(directory), existing = store.load();
  if (existing) return { ...existing, appliedRevision: existing.savedRevision, replayed: true, notices: [] };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionId)) throw new SequenceError('INVALID_DOCUMENT', '移行の実行IDが不正です');
  const linkFingerprint = await legacyLinkFingerprint(directory);
  const migrated = await prepareLegacySequenceSnapshot(directory, signal, true);
  if (await legacyInputFingerprint(directory) !== migrated.document.legacy?.sourceFingerprint) throw new SequenceError('REVISION_CONFLICT', '移行中に旧編集データが変更されました。現在の内容からやり直してください');
  if (await legacyLinkFingerprint(directory) !== linkFingerprint) throw new SequenceError('REVISION_CONFLICT', '移行中にリンク元の接続記録が変更されました。現在の内容からやり直してください');
  signal?.throwIfAborted();
  const saved = store.save({ expectedSavedRevision: null, executionId, document: migrated.document });
  return { ...saved, notices: migrated.notices };
}

/** Freeze legacy media/components and build a document without changing editing
 * authority. Export callers must own admission/cancellation for the preparation;
 * managed assets may be reused, but this function never saves project.v2.json. */
export async function prepareLegacySequenceSnapshot(directory: string, signal?: AbortSignal, preserveCuts=false): Promise<LegacyMigrationResult> {
  signal?.throwIfAborted();
  assertLegacySequenceAuthority(directory);
  const sourceFingerprint = await legacyInputFingerprint(directory), project = loadProject(readProjectFiles(directory));
  const catalog = await prepareLegacyPreviewCatalog(directory, legacyPreviewReferences(project), signal, sourceFingerprint);
  const convert=preserveCuts?migrateLegacyWithCutHistory:migrateLegacySequence;
  const migrated = convert({ id: randomUUID(), name: basename(directory), project, assets: catalog.assets, bindings: catalog.bindings, sourceFingerprint });
  if (migrated.document.rendering) migrated.document.rendering.staticFiles = catalog.staticFiles;
  return migrated;
}

/** Freeze the resources named by the live editor without saving either format.
 * Callers validate HTTP references; paths still pass the project asset resolver. */
export async function prepareLegacyPreviewCatalog(directory: string, references: LegacyPreviewReferences, signal?: AbortSignal, expectedFingerprint?: string, allowMissingMain = false): Promise<LegacyPreviewCatalog> {
  signal?.throwIfAborted();
  assertLegacySequenceAuthority(directory);
  const sourceFingerprint = await legacyInputFingerprint(directory);
  if (expectedFingerprint !== undefined && sourceFingerprint !== expectedFingerprint) throw new SequenceError('REVISION_CONFLICT', '素材の準備前に旧編集データが変更されました');
  const assets = new Map<string, SequenceAsset>();
  const bindings: LegacyAssetBindings = { main: '', images: {}, videoInserts: {}, bgm: {}, se: {} };
  const register = (asset: SequenceAsset): string => { if (!assets.has(asset.id)) assets.set(asset.id, asset); return asset.id; };
  if (references.telop) bindings.telopComponent = register(await freezeSequenceComponent(directory, 'src/テロップテンプレート/Telop.tsx', 'Telop'));
  if (references.image) bindings.imageComponent = register(await freezeSequenceComponent(directory, 'src/InsertImage/InsertImage.tsx', 'InsertImage'));
  let mainPath: string | undefined, verifyLinkedMain: (() => Promise<void>) | undefined;
  try {
    const linked = readVideoLink(directory);
    if (linked) {
      const candidate = join(directory, 'public', references.main), state = inspectVideoLink(directory, references.main)?.state;
      if (state === 'broken') throw new HttpError(404, 'リンク元の映像が見つかりません');
      // Mismatched or unregistered links remain errors, including in draft preview.
      if (state !== 'ok' || await realpath(candidate) !== await realpath(linked.target)) throw new Error('リンク元の映像が変更されています');
      mainPath = await realpath(candidate);
      // Keep the old record, public leaf and original generation fixed while the
      // current bytes are registered. Old size/mtime records are not a historical SHA.
      const recordPath = await managedAssetPath(directory, '.sme/videoLink.json');
      const generation = async () => {
        const identity = (s: Awaited<ReturnType<typeof stat>>) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
        return JSON.stringify([
          await managedAssetPath(directory, '.sme/videoLink.json'), await readFile(recordPath, 'utf8'),
          identity(await lstat(recordPath)), identity(await lstat(candidate)), identity(await stat(mainPath!)),
          await realpath(candidate), await realpath(linked.target), readVideoLink(directory),
        ]);
      };
      const initialGeneration = await generation();
      verifyLinkedMain = async () => {
        try {
          if (JSON.stringify(readVideoLink(directory)) !== JSON.stringify(linked)
            || inspectVideoLink(directory, references.main)?.state !== 'ok'
            || await realpath(candidate) !== mainPath || await realpath(linked.target) !== mainPath
            || await generation() !== initialGeneration) throw new Error('changed');
        } catch {
          throw new SequenceError('REVISION_CONFLICT', '移行中にリンク元の映像または接続記録が変更されました。現在の内容からやり直してください');
        }
      };
      await verifyLinkedMain();
    } else mainPath = resolvePublicAsset(directory, references.main);
  } catch (error) {
    if (!allowMissingMain || !(error instanceof HttpError) || error.status !== 404) throw error;
    // Public HTTP resolution intentionally hides filesystem details. Confirm
    // absence from the original errno before granting this display-only fallback.
    try { await stat(join(directory, 'public', references.main)); throw error; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      // A real missing path is the sole exception; corrupt/existing media still
      // goes through the normal importer and cannot become a background preview.
      mainPath = undefined;
    }

  }
  const staticFiles: Record<string, string> = {}, imported = new Map<string, string>();
  if (mainPath) {
    let asset: SequenceAsset | undefined;
    if (verifyLinkedMain) {
      const known = await registeredSequenceReferences(directory);
      if (known.length) {
        const inspected = await inspectSequenceAssetSource(mainPath, references.main, basename(references.main), signal);
        const existing = known.find(asset => asset.fingerprint === inspected.fingerprint && asset.kind === inspected.kind);
        if (existing) {
          await verifyLinkedMain();
          const target = await readlink(join(directory, existing.file)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
          if (target === mainPath) {
            const lease = await openSequenceReference(directory, existing, signal);
            try { await lease.verify(); asset = existing; } finally { await lease.close(); }
          } else {
            // The revalidated legacy link explicitly authorizes the current path.
            // General registration still never relocates an existing reference.
            asset = await reconnectSequenceReference(directory, existing, mainPath, signal);
          }
        }
      }
    }
    asset ??= await (verifyLinkedMain ? registerSequenceReference : importSequenceAsset)(directory, mainPath, basename(references.main), signal);
    bindings.main = register(asset);
    staticFiles[references.main] = bindings.main; imported.set(mainPath, bindings.main);
  }
  for (const [items, prefix, binding] of [
    [references.images, 'images/', bindings.images], [references.videoInserts, '', bindings.videoInserts],
    [references.bgm, 'BGM/', bindings.bgm], [references.se, 'se/', bindings.se],
  ] as const) for (const item of items) {
    signal?.throwIfAborted();
    const path = resolvePublicAsset(directory, prefix + item.file);
    let id = imported.get(path);
    if (!id) { id = register(await importSequenceAsset(directory, path, basename(item.file), signal)); imported.set(path, id); }
    binding[item.id] = id;
    staticFiles[prefix + item.file] = id;
  }
  signal?.throwIfAborted();
  if (await legacyInputFingerprint(directory) !== sourceFingerprint) throw new SequenceError('REVISION_CONFLICT', '移行中に旧編集データが変更されました。現在の内容からやり直してください');
  await verifyLinkedMain?.();
  assertLegacySequenceAuthority(directory);
  return { ...(!mainPath ? {missingMain:true as const} : {}), references: structuredClone(references), sourceFingerprint, assets: [...assets.values()], bindings, staticFiles };
}
