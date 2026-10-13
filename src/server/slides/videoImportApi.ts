import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SequenceError } from '../../core/sequence/errors';
import { HttpError, sendJson } from '../http';
import { resolveProjectDir } from '../projectRoot';
import { readJsonBody } from '../readBody';
import { id, integer, object } from '../sequence/editRequest';
import { SequenceStore } from '../sequence/store';
import { buildSlideImportCommands, type SlideImportRecord } from '../../core/slides/videoImport';
import { registeredSequenceAssets, verifiedSequenceAssetPath } from '../sequence/assets';
import { sequenceService } from '../sequence/service';
import { SlidesImportLedger } from './videoImport';

type Placed = NonNullable<SlideImportRecord['placed']>;
/** 置いたクリップが、いまの編集状態（元に戻した後も含む）の動画に 1 つでも残っているか。クリップ ID の記録が空なら判断できないので置いてある扱い。 */
const stillPlaced = (clips: ReadonlyArray<{ id: string }>) => (placed: Placed) => !placed.clipIds.length || placed.clipIds.some(clipId => clips.some(clip => clip.id === clipId));
/** 置くクリップの ID に取り込み ID と実行 ID の指紋を入れる。記録の書き込みに失敗しても、動画の文書から「置いたか」「同じ実行の再送か」を照合できる。 */
const placementTag = (importId: string, executionId: string) => `${importId}-${createHash('sha256').update(executionId).digest('hex').slice(0, 16)}`;
const taggedClipIds = (clips: ReadonlyArray<{ id: string }>, tag: string) => clips.filter(clip => clip.id.startsWith(`slides-clip-${tag}-`)).map(clip => clip.id);
const liveClipIds = (clips: ReadonlyArray<{ id: string }>) => (record: SlideImportRecord) => taggedClipIds(clips, record.importId);
/** 動画の保存中枢の拒否（版の衝突・外部変更・操作の検証エラー）は 409／400 に振り分ける。 */
const errorStatus = (error: unknown) => error instanceof HttpError ? error.status : error instanceof SequenceError ? error.code === 'REVISION_CONFLICT' ? 409 : 400 : 500;

/** 動画案件の側から見た、スライドから届いた画像の記録（一覧・置く）。動画の保存中枢には触れない。 */
export async function handleSlidesImportsApi(req: IncomingMessage, res: ServerResponse, url: URL, root: string): Promise<boolean> {
  if (url.pathname !== '/api/slides-imports' && url.pathname !== '/api/slides-imports/place') return false;
  try {
    const projectId = url.searchParams.get('id');
    if (!projectId) throw new HttpError(400, 'プロジェクトIDが必要です');
    const directory = resolveProjectDir(root, projectId), saved = resolve(root) === resolve(directory) || !existsSync(directory) ? null : new SequenceStore(directory).load();
    if (!saved) throw new HttpError(404, '対象の動画案件がありません');
    const ledger = new SlidesImportLedger(directory), method = req.method ?? 'GET';
    if (url.pathname === '/api/slides-imports') {
      if (method !== 'GET') throw new HttpError(405, 'この操作は GET のみ対応します');
      // 記録の書き込みに失敗していた置き場所は、動画の文書（編集中の状態。開けなければ保存版）から照合して直す。
      let document = saved.document;
      try { document = sequenceService.open(directory).document; } catch { /* 外部変更などで開けない時は保存版で照合する */ }
      sendJson(res, 200, { imports: ledger.reconcile(liveClipIds(document.clips), document.revision) });
      return true;
    }
    if (method !== 'POST') throw new HttpError(405, 'この操作は POST のみ対応します');
    const body = object(await readJsonBody(req)), importId = id(body.importId), executionId = id(body.executionId);
    // 取り込んだ画像を新しい映像トラックに置く。動画の編集状態（元に戻せる履歴）に型付きの操作として入れ、置いた記録も残す。
    const state = sequenceService.open(directory);
    if (state.sessionId !== id(body.sessionId)) throw new HttpError(409, '編集状態が変わりました。開き直してから置いてください');
    const record = ledger.reconcile(liveClipIds(state.document.clips), state.document.revision).find(item => item.importId === importId);
    if (!record) throw new HttpError(404, '取り込みの記録がありません');
    const tag = placementTag(record.importId, executionId), replayedClipIds = taggedClipIds(state.document.clips, tag);
    if (replayedClipIds.length) {
      // 同じ実行の再送: 置き直さず、置いた結果を返す。
      sendJson(res, 200, { record, state: { ...state, executionId, appliedRevision: record.placed?.videoRevision ?? state.document.revision, changed: true, replayed: true } });
      return true;
    }
    if (state.document.revision !== integer(body.expectedRevision)) throw new HttpError(409, '編集状態が変わりました。開き直してから置いてください');
    if (record.placed && stillPlaced(state.document.clips)(record.placed)) throw new HttpError(409, 'この取り込みはもう置いてあります');
    const registry = await registeredSequenceAssets(directory), known = new Set(state.document.assets.map(asset => asset.id));
    const missing = record.pages.map(page => page.assetId).filter((assetId, index, all) => !known.has(assetId) && all.indexOf(assetId) === index)
      .map(assetId => registry.find(asset => asset.id === assetId) ?? (() => { throw new HttpError(404, '取り込み済みの素材がありません'); })());
    const signal = new AbortController().signal;
    for (const asset of missing) await verifiedSequenceAssetPath(directory, asset, signal);
    const at = body.at === undefined ? state.document.sequenceEndFrame : integer(body.at);
    let serial = 0;
    const built = buildSlideImportCommands({ ...state.document, assets: [...state.document.assets, ...missing] }, record, at, prefix => `${prefix}-${tag}-${serial++}`);
    const result = sequenceService.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId,
      command: { type: 'batch', commands: missing.length ? [{ type: 'register-assets', assets: missing }, ...built.commands] : built.commands } });
    // 記録は動画への実行が成功した後に書く。書けなくても置いた結果は返す（次の読み込みで動画の文書から照合して直す）。
    const placed: Placed = { at: new Date().toISOString(), videoRevision: result.appliedRevision, clipIds: built.clipIds };
    let written: SlideImportRecord;
    try { written = ledger.markPlaced(record.importId, placed, stillPlaced(state.document.clips)); }
    catch (error) {
      console.warn('[sme] スライドの取り込みの置いた記録を書けませんでした（次の読み込みで直します）:', error instanceof Error ? error.message : error);
      written = { ...record, placed };
    }
    sendJson(res, 200, { record: written, state: result });
    return true;
  } catch (error) {
    sendJson(res, errorStatus(error), { error: error instanceof Error ? error.message : 'スライドの取り込みの処理に失敗しました',
      ...(error instanceof SequenceError ? { code: error.code, targets: error.targets } : {}) });
    return true;
  }
}
