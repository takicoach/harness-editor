import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceAsset } from '../../core/sequence/model';
import { HttpError, sendJson } from '../http';
import { resolveProjectDir } from '../projectRoot';
import { readJsonBody } from '../readBody';
import { serveAsset } from '../serveAsset';
import { assertContentLengthWithin, resolveMaxUploadBytes, streamBodyToTempFile } from '../streamUpload';
import { importSequenceAsset, registeredSequenceAssets, verifiedSequenceAssetPath } from '../sequence/assets';
import { id, integer, object } from '../sequence/editRequest';
import { serveSequenceAsset } from '../sequence/serveAsset';
import { SequenceStore } from '../sequence/store';
import { readThumbnailCover } from './cover';
import { thumbnailExports, type ThumbnailExports } from './exports';
import { thumbnailPreviews, type ThumbnailPreviews } from './previews';
import { thumbnailEditRequest } from './request';
import { thumbnailRenderInputs, type ThumbnailRenderInputs } from './renderInputs';
import { ThumbnailBrokenError, ThumbnailConflictError, thumbnailService, type ThumbnailService } from './service';

export interface ThumbnailApiDeps { service: ThumbnailService; inputs: ThumbnailRenderInputs; exports: ThumbnailExports; previews: ThumbnailPreviews }
export function thumbnailApiDefaults(): ThumbnailApiDeps { return { service: thumbnailService, inputs: thumbnailRenderInputs, exports: thumbnailExports, previews: thumbnailPreviews }; }
const POST_ROUTES = ['/create', '/session', '/session/status', '/session/reload', '/command', '/save', '/discard', '/recover', '/upload', '/register', '/assets/check', '/export', '/export/cancel', '/preview'];
const GET_ROUTES = ['', '/asset', '/export/input', '/export/asset', '/export/status', '/export/file', '/preview/image', '/cover'];
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/** 取り込み済み（素材台帳）か、動画の保存済み文書にある素材だけを登録できる。サムネに使えるのは画像と映像。 */
async function knownAssets(directory: string, assetIds: unknown): Promise<SequenceAsset[]> {
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 20 || assetIds.some(value => typeof value !== 'string')) throw new HttpError(400, '登録する素材IDが必要です');
  const registry = await registeredSequenceAssets(directory), video = new SequenceStore(directory).load()?.document.assets ?? [];
  return (assetIds as string[]).map(assetId => {
    const asset = registry.find(item => item.id === assetId) ?? video.find(item => item.id === assetId);
    if (!asset) throw new HttpError(404, '取り込み済みの素材がありません');
    if (asset.kind !== 'image' && !(asset.kind === 'media' && asset.streams.some(stream => stream.kind === 'video'))) throw new HttpError(400, 'サムネに使えるのは画像と映像だけです');
    return asset;
  });
}

/** 既存のローカル起源ガードの内側で呼ぶ。クライアントのファイルパスは受け取らない。 */
export async function handleThumbnailApi(req: IncomingMessage, res: ServerResponse, url: URL, root: string, deps: ThumbnailApiDeps = thumbnailApiDefaults()): Promise<boolean> {
  if (url.pathname !== '/api/thumbnail' && !url.pathname.startsWith('/api/thumbnail/')) return false;
  const controller = new AbortController(), closed = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', closed);
  try {
    const projectId = url.searchParams.get('id');
    if (!projectId) throw new HttpError(400, 'プロジェクトIDが必要です');
    const directory = resolveProjectDir(root, projectId);
    if (resolve(root) === resolve(directory) || !existsSync(directory)) throw new HttpError(404, '対象のプロジェクトがありません');
    const route = url.pathname.slice('/api/thumbnail'.length), method = req.method ?? 'GET', post = POST_ROUTES.includes(route);
    if (!post && !GET_ROUTES.includes(route)) throw new HttpError(404, 'サムネの API が見つかりません');
    if (method !== (post ? 'POST' : 'GET')) throw new HttpError(405, `この操作は ${post ? 'POST' : 'GET'} のみ対応します`);
    const { service } = deps;
    if (!post) {
      switch (route) {
        case '': sendJson(res, 200, service.status(directory)); break;
        case '/asset': {
          const assetId = url.searchParams.get('asset') ?? '';
          const asset = service.findAsset(directory, assetId) ?? (await registeredSequenceAssets(directory)).find(item => item.id === assetId);
          if (!asset) throw new HttpError(404, '指定された素材がありません');
          // 原本を配る（プレビュー用の軽い代わりの映像は使わない）。
          await serveSequenceAsset(res, directory, asset, req.headers.range, controller.signal);
          break;
        }
        case '/export/input': sendJson(res, 200, { document: deps.inputs.get(directory, id(url.searchParams.get('job'))) }); break;
        case '/export/asset': {
          const document = deps.inputs.get(directory, id(url.searchParams.get('job')));
          const asset = document.assets.find(item => item.id === url.searchParams.get('asset'));
          if (!asset) throw new HttpError(404, '固定した入力に指定の素材がありません');
          await serveSequenceAsset(res, directory, asset, req.headers.range, controller.signal);
          break;
        }
        case '/export/status': {
          const status = deps.exports.status(directory, id(url.searchParams.get('executionId')));
          if (!status) throw new HttpError(404, '書き出しの記録がありません');
          sendJson(res, 200, status);
          break;
        }
        case '/export/file': serveAsset(res, deps.exports.outputFile(directory, id(url.searchParams.get('executionId'))), req.headers.range); break;
        case '/cover': {
          // プロジェクトのカードの画像。案件内の サムネ/<案件名> サムネ.(png|jpg) だけを返す（名前・パスは受け取らない）。
          const cover = readThumbnailCover(directory);
          if (!cover) throw new HttpError(404, 'サムネの書き出しがありません');
          res.writeHead(200, { 'Content-Type': cover.type, 'Content-Length': String(cover.bytes.length), 'Cache-Control': 'no-store' }).end(cover.bytes);
          break;
        }
        case '/preview/image': {
          const image = deps.previews.image(directory, id(url.searchParams.get('pageId')), id(url.searchParams.get('hash')));
          if (!image) throw new HttpError(404, '縮小画像はまだできていません');
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(image);
          break;
        }
      }
      return true;
    }
    if (route === '/upload') {
      const name = basename((url.searchParams.get('name') ?? '').replaceAll('\\', '/')).normalize('NFC').trim();
      if (!name || name.startsWith('.') || !IMAGE_NAME.test(name)) throw new HttpError(400, '画像ファイル（PNG・JPEG・WebP など）を選んでください');
      const maximum = resolveMaxUploadBytes(); assertContentLengthWithin(req, maximum);
      const temporary = await mkdtemp(join(tmpdir(), 'harness-thumbnail-upload-'));
      try {
        const file = await streamBodyToTempFile(req, temporary, maximum), asset = await importSequenceAsset(directory, file, name, controller.signal);
        if (asset.kind !== 'image') throw new HttpError(400, '画像として読み込めませんでした');
        sendJson(res, 200, { asset });
      } finally { await rm(temporary, { recursive: true, force: true }); }
      return true;
    }
    const body = object(await readJsonBody(req));
    switch (route) {
      case '/create': sendJson(res, 200, service.create(directory, id(body.executionId))); break;
      case '/session': sendJson(res, 200, service.open(directory)); break;
      case '/session/status': sendJson(res, 200, service.inspect(directory, id(body.sessionId))); break;
      case '/session/reload': sendJson(res, 200, service.reload(directory, id(body.sessionId), integer(body.expectedRevision))); break;
      case '/discard': sendJson(res, 200, service.discard(directory, id(body.sessionId), integer(body.expectedRevision))); break;
      case '/command': sendJson(res, 200, service.execute(directory, thumbnailEditRequest(body))); break;
      case '/save': sendJson(res, 200, service.save(directory, { sessionId: id(body.sessionId), executionId: id(body.executionId),
        expectedRevision: integer(body.expectedRevision), expectedSavedRevision: integer(body.expectedSavedRevision) })); break;
      case '/recover':
        if (body.choice !== 'backup' && body.choice !== 'new') throw new HttpError(400, '復旧の方法が不正です');
        sendJson(res, 200, service.recover(directory, body.choice, id(body.executionId))); break;
      case '/register': {
        const assets = await knownAssets(directory, body.assetIds);
        for (const asset of assets) await verifiedSequenceAssetPath(directory, asset, controller.signal);
        sendJson(res, 200, service.execute(directory, { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId),
          command: { type: 'register-assets', assets } }));
        break;
      }
      case '/export': {
        if (body.format !== 'png' && body.format !== 'jpeg') throw new HttpError(400, '書き出しの形式は PNG か JPEG です');
        const port = req.socket.localPort;
        if (!port) throw new HttpError(500, 'ローカルサーバーのポートを確認できません');
        const request = { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId), pageId: id(body.pageId), format: body.format as 'png' | 'jpeg' };
        sendJson(res, 200, deps.exports.start({ directory, projectId, origin: `http://127.0.0.1:${port}`, request, state: () => service.inspect(directory, request.sessionId) }));
        break;
      }
      case '/export/cancel': sendJson(res, 200, deps.exports.cancel(directory, id(body.executionId))); break;
      case '/preview': {
        const port = req.socket.localPort;
        if (!port) throw new HttpError(500, 'ローカルサーバーのポートを確認できません');
        sendJson(res, 200, deps.previews.request({ directory, projectId, origin: `http://127.0.0.1:${port}`, state: service.inspect(directory, id(body.sessionId)), pageId: id(body.pageId) }));
        break;
      }
      case '/assets/check': {
        const state = service.inspect(directory, id(body.sessionId)), unavailable: string[] = [];
        for (const asset of state.document.assets) {
          try { await verifiedSequenceAssetPath(directory, asset, controller.signal); } catch { unavailable.push(asset.id); }
        }
        sendJson(res, 200, { unavailable });
        break;
      }
    }
    return true;
  } catch (error) {
    if (controller.signal.aborted) return true;
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return true; }
    if (error instanceof ThumbnailBrokenError) { sendJson(res, 409, { error: error.message, code: 'THUMBNAIL_BROKEN', preservedFile: error.preservedFile }); return true; }
    const status = error instanceof HttpError ? error.status : error instanceof SequenceError
      ? error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'MISSING_TARGET' ? 404 : 400 : 422;
    sendJson(res, status, { error: error instanceof Error ? error.message : 'サムネの処理に失敗しました',
      ...(error instanceof SequenceError ? { code: error.code, targets: error.targets } : {}),
      ...(error instanceof ThumbnailConflictError && error.evacuatedFile ? { evacuatedFile: error.evacuatedFile } : {}) });
    return true;
  } finally { res.off('close', closed); }
}
