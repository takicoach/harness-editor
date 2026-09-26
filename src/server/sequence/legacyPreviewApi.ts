import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';
import { rational } from '../../core/sequence/time';
import { HttpError, sendJson, sendText } from '../http';
import { resolveProjectDir } from '../projectRoot';
import { readJsonBody } from '../readBody';
import { serveAsset } from '../serveAsset';
import { serveSequenceAsset } from './serveAsset';
import { verifiedSequenceAssetPath } from './assets';
import { readSequenceComponent } from './components';
import { prepareSequenceAudio } from './media';
import { legacyPreviewContexts, parseLegacyPreviewReferences, type LegacyPreviewContexts } from './legacyPreviewContexts';

/** Separate from saved-v2 API: no registry fallback, native session, save or job. */
export async function handleLegacyPreviewApi(req: IncomingMessage, res: ServerResponse, url: URL, root: string, contexts: LegacyPreviewContexts = legacyPreviewContexts): Promise<boolean> {
  const prefix = '/api/legacy-preview';
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  const controller = new AbortController(), abort = () => controller.abort();
  let leaseSignal: AbortSignal | undefined;
  const close = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort); res.once('close', close);
  try {
    const id = url.searchParams.get('id');
    if (!id) throw new HttpError(400, 'プロジェクトIDが必要です');
    const resolved = resolveProjectDir(root, id);
    if (resolve(root) === resolve(resolved)) throw new HttpError(404, '対象のプロジェクトがありません');
    let directory: string;
    try { directory = await realpath(resolved); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const token = url.searchParams.get('context'); if (token) contexts.release(resolved, token);
      throw new HttpError(404, '案件フォルダーが変更されています');
    }
    const route = url.pathname.slice(prefix.length), method = req.method ?? 'GET';
    if (!['', '/asset', '/component', '/audio/info', '/audio/data'].includes(route)) throw new HttpError(404, 'プレビューの操作がありません');
    if (route === '' && method === 'POST') {
      const references = parseLegacyPreviewReferences(await readJsonBody(req, 1024 * 1024));
      const context = await contexts.create(directory, references, controller.signal);
      sendJson(res, 200, { token: context.token, expiresAt: context.expiresAt, catalog: context.catalog }); return true;
    }
    const token = url.searchParams.get('context');
    if (!token) throw new HttpError(400, 'プレビューの素材情報が必要です');
    if (route === '' && method === 'DELETE') { contexts.release(directory, token); sendJson(res, 200, { released: true }); return true; }
    if (method !== 'GET') throw new HttpError(405, 'プレビュー操作のメソッドが不正です');
    const context = contexts.get(directory, token);
    leaseSignal = context.signal;
    const signal = AbortSignal.any([controller.signal, context.signal]);
    if (route === '') { sendJson(res, 200, { token, expiresAt: context.expiresAt }); return true; }
    const asset = context.catalog.assets.find(item => item.id === url.searchParams.get('asset'));
    if (!asset) throw new HttpError(404, 'このプレビューには指定された素材がありません');
    const check = () => { signal.throwIfAborted(); contexts.get(directory, token); };
    if (route === '/component') {
      const source = await readSequenceComponent(directory, asset); check();
      sendText(res, 200, source, 'text/javascript; charset=utf-8'); return true;
    }
    if (route === '/asset') { check(); await serveSequenceAsset(res, directory, asset, req.headers.range, signal); return true; }
    await verifiedSequenceAssetPath(directory, asset, signal);
    check();
    if (!url.searchParams.has('stream')) throw new HttpError(400, '音声ストリーム番号が必要です');
    const stream = Number(url.searchParams.get('stream'));
    if (!Number.isSafeInteger(stream) || stream < 0) throw new HttpError(400, '音声ストリーム番号が不正です');
    const rate = rational(Number(url.searchParams.get('rateNum') ?? 1), Number(url.searchParams.get('rateDen') ?? 1));
    const pcm = await prepareSequenceAudio(directory, asset, stream, rate, signal); check();
    if (route === '/audio/data') serveAsset(res, pcm.file, req.headers.range);
    else sendJson(res, 200, { sampleRate: pcm.sampleRate, channels: pcm.channels, sampleCount: pcm.sampleCount, rate: pcm.rate,
      url: `${prefix}/audio/data?${new URLSearchParams({ id, context: token, asset: asset.id, stream: String(stream), rateNum: String(rate.num), rateDen: String(rate.den) })}` });
    return true;
  } catch (error) {
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return true; }
    if (controller.signal.aborted) return true;
    if (leaseSignal?.aborted) error = leaseSignal.reason;
    const status = error instanceof HttpError ? error.status : error instanceof SequenceError
      ? error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'MISSING_TARGET' ? 404 : 400 : 422;
    sendJson(res, status, { error: error instanceof Error ? error.message : 'プレビューの素材を準備できませんでした' }); return true;
  } finally { req.off('aborted', abort); res.off('close', close); }
}
