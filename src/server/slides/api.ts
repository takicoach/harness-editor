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
import { assertContentLengthWithin, resolveMaxUploadBytes, streamBodyToTempFile } from '../streamUpload';
import { importSequenceAsset, registeredSequenceAssets, verifiedSequenceAssetPath } from '../sequence/assets';
import { id, integer, object } from '../sequence/editRequest';
import { serveSequenceAsset } from '../sequence/serveAsset';
import { createSlidesProject, isSlidesProject, listSlidesProjects } from './projects';
import { nextPendingKeys, outlineRequestText, pagesRequestText } from '../../core/slides/prompts';
import { slidesEditRequest } from './request';
import { slidesRenderInputs, type SlidesRenderInputs } from './renderInputs';
import { slidesPreviews, type SlidesPreviews } from './previews';
import { serveAsset } from '../serveAsset';
import { slidesExports, type SlidesExportFormat, type SlidesExports } from './exports';
import { SlidesAgentError, slidesAgent, type SlidesAgent } from './agent';
import { SlidesBrokenError, SlidesConflictError, slidesService, type SlidesService } from './service';
import { slidesVideoImports, type SlidesVideoImports } from './videoImport';
import { heavyJobCounts, heavyJobGate } from '../systemLoad';

/** heavyJobAllowed: 重い処理の枠（heavyJobGate）が空いているか。書き出し・縮小画像・動画への取り込みの Chromium を起動する前に確かめる。 */
export interface SlidesApiDeps { service: SlidesService; agent: SlidesAgent; inputs: SlidesRenderInputs; previews: SlidesPreviews; exports: SlidesExports; videoImports: SlidesVideoImports;
  heavyJobAllowed: () => boolean }
export function slidesApiDefaults(): SlidesApiDeps {
  return { service: slidesService, agent: slidesAgent, inputs: slidesRenderInputs, previews: slidesPreviews, exports: slidesExports, videoImports: slidesVideoImports,
    heavyJobAllowed: () => heavyJobGate(false, { counts: heavyJobCounts() }).allowed };
}
const POST_ROUTES = ['/session', '/session/status', '/session/reload', '/command', '/save', '/discard', '/recover', '/upload', '/register', '/assets/check', '/validate', '/apply', '/preview', '/export', '/export/cancel', '/video-import'];
const GET_ROUTES = ['', '/asset', '/runs', '/request-text', '/export/input', '/export/asset', '/preview/image', '/export/status', '/export/file'];
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const kindOf = (value: unknown): 'outline' | 'pages' => {
  if (value !== 'outline' && value !== 'pages') throw new HttpError(400, 'kind は outline か pages です');
  return value;
};
const count = (value: string | null): number | undefined => value === null ? undefined : integer(Number(value));
/** 描画ページ（同じサーバー）の起点。撮影のブラウザはここを開く。 */
function localOrigin(req: IncomingMessage): string {
  const port = req.socket.localPort;
  if (!port) throw new HttpError(500, 'ローカルサーバーのポートを確認できません');
  return `http://127.0.0.1:${port}`;
}

/** スライドに登録できるのは、素材台帳にある画像だけ。 */
async function registryImages(directory: string, assetIds: unknown): Promise<SequenceAsset[]> {
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 20 || assetIds.some(value => typeof value !== 'string')) throw new HttpError(400, '登録する素材IDが必要です');
  const registry = await registeredSequenceAssets(directory);
  return (assetIds as string[]).map(assetId => {
    const asset = registry.find(item => item.id === assetId);
    if (!asset) throw new HttpError(404, '取り込み済みの素材がありません');
    if (asset.kind !== 'image') throw new HttpError(400, 'スライドに使えるのは画像だけです');
    return asset;
  });
}

/** 既存のローカル起源ガードの内側で呼ぶ。クライアントのファイルパスは受け取らない。overrides はテストの差し替え用。 */
export async function handleSlidesApi(req: IncomingMessage, res: ServerResponse, url: URL, root: string, overrides: Partial<SlidesApiDeps> = {}): Promise<boolean> {
  if (url.pathname !== '/api/slides' && !url.pathname.startsWith('/api/slides/')) return false;
  const deps: SlidesApiDeps = { ...slidesApiDefaults(), ...overrides };
  const controller = new AbortController(), closed = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', closed);
  try {
    const method = req.method ?? 'GET';
    if (url.pathname === '/api/slides/projects') {
      if (method !== 'GET') throw new HttpError(405, 'この操作は GET のみ対応します');
      sendJson(res, 200, { projects: listSlidesProjects(root) });
      return true;
    }
    if (url.pathname === '/api/slides/projects/create') {
      if (method !== 'POST') throw new HttpError(405, 'この操作は POST のみ対応します');
      const body = object(await readJsonBody(req));
      if (typeof body.name !== 'string') throw new HttpError(400, 'スライドの名前を入れてください');
      sendJson(res, 200, createSlidesProject(root, body.name));
      return true;
    }
    const projectId = url.searchParams.get('id');
    if (!projectId) throw new HttpError(400, 'スライドの ID が必要です');
    const directory = resolveProjectDir(root, projectId);
    if (resolve(root) === resolve(directory) || !existsSync(directory) || !isSlidesProject(directory)) throw new HttpError(404, '対象のスライドがありません');
    const route = url.pathname.slice('/api/slides'.length), post = POST_ROUTES.includes(route);
    if (!post && !GET_ROUTES.includes(route)) throw new HttpError(404, 'スライドの API が見つかりません');
    if (method !== (post ? 'POST' : 'GET')) throw new HttpError(405, `この操作は ${post ? 'POST' : 'GET'} のみ対応します`);
    const { service } = deps;
    if (!post) {
      switch (route) {
        case '': sendJson(res, 200, service.status(directory)); break;
        case '/asset': {
          const assetId = url.searchParams.get('asset') ?? '';
          const asset = service.findAsset(directory, assetId) ?? (await registeredSequenceAssets(directory)).find(item => item.id === assetId && item.kind === 'image');
          if (!asset) throw new HttpError(404, '指定された素材がありません');
          await serveSequenceAsset(res, directory, asset, req.headers.range, controller.signal);
          break;
        }
        case '/runs': sendJson(res, 200, deps.agent.runs(projectId, { operationId: url.searchParams.get('operationId') ?? undefined, runId: url.searchParams.get('runId') ?? undefined,
          offset: count(url.searchParams.get('offset')), limit: count(url.searchParams.get('limit')) })); break;
        case '/request-text': {
          // 「依頼文をコピー」。いまのセッションの文書（未保存の直しも含む）から作る。
          const document = service.open(directory).document;
          if (url.searchParams.get('kind') === 'outline') { sendJson(res, 200, { text: outlineRequestText(document), keys: [] }); break; }
          if (url.searchParams.get('kind') !== 'pages') throw new HttpError(400, 'kind は outline か pages です');
          const listed = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean), keys = listed.length ? listed : nextPendingKeys(document);
          sendJson(res, 200, { text: pagesRequestText(document, keys, { regenerate: url.searchParams.get('regenerate') === '1', shorten: url.searchParams.get('shorten') === '1' }), keys });
          break;
        }
        case '/export/input': sendJson(res, 200, { document: deps.inputs.get(directory, id(url.searchParams.get('job')), integer(Number(url.searchParams.get('page')))) }); break;
        case '/export/asset': {
          const asset = deps.inputs.asset(directory, id(url.searchParams.get('job')), url.searchParams.get('asset') ?? '');
          await serveSequenceAsset(res, directory, asset, req.headers.range, controller.signal);
          break;
        }
        case '/preview/image': {
          const image = deps.previews.image(directory, id(url.searchParams.get('pageId')), id(url.searchParams.get('hash')));
          if (!image) throw new HttpError(404, '縮小画像はまだできていません');
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(image);
          break;
        }
        case '/export/status': {
          const status = deps.exports.status(directory, id(url.searchParams.get('executionId')));
          if (!status) throw new HttpError(404, '書き出しの記録がありません');
          sendJson(res, 200, status);
          break;
        }
        case '/export/file': serveAsset(res, deps.exports.outputFile(directory, id(url.searchParams.get('executionId')), count(url.searchParams.get('index')) ?? 0), req.headers.range); break;
        // ここより上に GET の経路を足す
        default: throw new HttpError(404, 'スライドの API が見つかりません');
      }
      return true;
    }
    if (route === '/upload') {
      const name = basename((url.searchParams.get('name') ?? '').replaceAll('\\', '/')).normalize('NFC').trim();
      if (!name || name.startsWith('.') || !IMAGE_NAME.test(name)) throw new HttpError(400, '画像ファイル（PNG・JPEG・WebP など）を選んでください');
      const maximum = resolveMaxUploadBytes(); assertContentLengthWithin(req, maximum);
      const temporary = await mkdtemp(join(tmpdir(), 'harness-slides-upload-'));
      try {
        const file = await streamBodyToTempFile(req, temporary, maximum), asset = await importSequenceAsset(directory, file, name, controller.signal);
        if (asset.kind !== 'image') throw new HttpError(400, '画像として読み込めませんでした');
        sendJson(res, 200, { asset });
      } finally { await rm(temporary, { recursive: true, force: true }); }
      return true;
    }
    const body = object(await readJsonBody(req));
    switch (route) {
      case '/session': sendJson(res, 200, service.open(directory)); break;
      case '/session/status': sendJson(res, 200, service.inspect(directory, id(body.sessionId))); break;
      case '/session/reload': sendJson(res, 200, service.reload(directory, id(body.sessionId), integer(body.expectedRevision))); break;
      case '/discard': sendJson(res, 200, service.discard(directory, id(body.sessionId), integer(body.expectedRevision))); break;
      case '/command': sendJson(res, 200, service.execute(directory, slidesEditRequest(body))); break;
      case '/save': sendJson(res, 200, service.save(directory, { sessionId: id(body.sessionId), executionId: id(body.executionId),
        expectedRevision: integer(body.expectedRevision), expectedSavedRevision: integer(body.expectedSavedRevision) })); break;
      case '/recover':
        if (body.choice !== 'backup' && body.choice !== 'new') throw new HttpError(400, '復旧の方法が不正です');
        sendJson(res, 200, service.recover(directory, body.choice, id(body.executionId))); break;
      case '/register': {
        const assets = await registryImages(directory, body.assetIds);
        for (const asset of assets) await verifiedSequenceAssetPath(directory, asset, controller.signal);
        sendJson(res, 200, service.execute(directory, { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId),
          command: { type: 'register-assets', assets } }));
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
      case '/validate': sendJson(res, 200, deps.agent.validate({ projectId, documentId: id(body.documentId), sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision),
        kind: kindOf(body.kind), regenerate: body.regenerate === true, payload: body.payload })); break;
      case '/apply': {
        // 貼り付けの経路。MCP の道具と同じ受け口・同じ検証器・同じ記録を通る（画像ファイルは受け取らない）。
        const base = { projectId, documentId: id(body.documentId), sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision),
          operationId: id(body.operationId), route: 'paste' as const, payload: body.payload };
        sendJson(res, 200, kindOf(body.kind) === 'outline' ? deps.agent.applyOutline(base) : await deps.agent.applyPages({ ...base, runId: id(body.runId), regenerate: body.regenerate === true }));
        break;
      }
      case '/preview': {
        if (!Array.isArray(body.pageIds) || body.pageIds.some(value => typeof value !== 'string')) throw new HttpError(400, 'ページ ID の一覧が必要です');
        sendJson(res, 200, { pages: deps.previews.request({ directory, projectId, origin: localOrigin(req), state: service.inspect(directory, id(body.sessionId)), pageIds: body.pageIds as string[],
          retry: body.retry === true, allowed: deps.heavyJobAllowed() }) });
        break;
      }
      case '/export': {
        if (body.format !== 'png' && body.format !== 'pdf' && body.format !== 'pdf-notes') throw new HttpError(400, '書き出しの形式は png・pdf・pdf-notes です');
        const request = { sessionId: id(body.sessionId), expectedRevision: integer(body.expectedRevision), executionId: id(body.executionId), format: body.format as SlidesExportFormat };
        // 同じ実行 ID の照会は枠に関係なく返す。新しく Chromium を起動する時だけ枠を確かめる。
        if (!deps.exports.status(directory, request.executionId) && !deps.heavyJobAllowed()) throw new HttpError(429, 'ほかの重い処理が進行中です。完了してから書き出してください');
        sendJson(res, 200, deps.exports.start({ directory, projectId, origin: localOrigin(req), request, state: () => service.inspect(directory, request.sessionId) }));
        break;
      }
      case '/export/cancel': sendJson(res, 200, deps.exports.cancel(directory, id(body.executionId))); break;
      case '/video-import': {
        if (!Array.isArray(body.pageIds) || body.pageIds.some(value => typeof value !== 'string')) throw new HttpError(400, '取り込むページを選んでください');
        if (typeof body.videoProjectId !== 'string' || !body.videoProjectId) throw new HttpError(400, '取り込み先の動画案件を選んでください');
        if (!deps.heavyJobAllowed()) throw new HttpError(429, 'ほかの重い処理が進行中です。完了してから取り込んでください');
        sendJson(res, 200, await deps.videoImports.start({ root, slidesDirectory: directory, slidesProjectId: projectId, origin: localOrigin(req),
          state: service.inspect(directory, id(body.sessionId)), pageIds: body.pageIds as string[], videoProjectId: body.videoProjectId, signal: controller.signal }));
        break;
      }
      // ここより上に POST の経路を足す
      default: throw new HttpError(404, 'スライドの API が見つかりません');
    }
    return true;
  } catch (error) {
    if (controller.signal.aborted) return true;
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return true; }
    if (error instanceof SlidesBrokenError) { sendJson(res, 409, { error: error.message, code: 'SLIDES_BROKEN', preservedFile: error.preservedFile }); return true; }
    if (error instanceof SlidesAgentError) {
      sendJson(res, error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409, { error: error.message, code: error.code, recovery: error.recovery });
      return true;
    }
    const status = error instanceof HttpError ? error.status : error instanceof SequenceError
      ? error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'MISSING_TARGET' ? 404 : 400 : 422;
    sendJson(res, status, { error: error instanceof Error ? error.message : 'スライドの処理に失敗しました',
      ...(error instanceof SequenceError ? { code: error.code, targets: error.targets } : {}),
      ...(error instanceof SlidesConflictError && error.evacuatedFile ? { evacuatedFile: error.evacuatedFile } : {}) });
    return true;
  } finally { res.off('close', closed); }
}
