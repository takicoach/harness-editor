import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, sendJson, sendText } from './http';
import { getProjectRoot, resolveProjectDir, resolvePublicAsset } from './projectRoot';
import { scanProjects } from './scanProjects';
import { parseVideoConfigStatic } from '../core';
import { loadProjectFromDir } from './loadProjectFiles';
import { isUploadKind, sanitizeUploadName, saveMaterialFile } from './uploadMaterial';
import { createProject, createProjectLinked, precheckCreateProject } from './createProject';
import { assertBrowsablePath, browseRoots, canCreateSymlink, listDirectory } from './browsePaths';
import {
  assertSourceAvailable,
  assertVideoProcessingAllowed,
  projectVideoFile,
} from './videoLink';
import { relinkVideo } from './relinkVideo';
import { probeSymlinkSupport } from './symlinkProbe';
import { streamBodyToTempFile, assertContentLengthWithin, resolveMaxUploadBytes } from './streamUpload';
import { readJsonBody } from './readBody';
import { triggerBackgroundInstall } from './backgroundInstall';
import { saveProjectToDir, validateSaveRequest } from './saveProject';
import { serveVideo } from './serveVideo';
import { previewProxyName, resolveVideoPathForVersion } from './previewProxy';
import { serveAsset } from './serveAsset';
import { bundleTelopComponent } from './bundleTelop';
import { isAllowedLocalRequest } from './localGuard';
import { bundleInsertImageComponent } from './bundleInsertImage';
import { bundleInsertVideoComponent } from './bundleInsertVideo';
import { convertBurnedInProject } from './convertProject';
import { installTelopPack } from './installTelopPack';
import { installVideoInsert } from './installVideoInsert';
import { installBgm } from './installBgm';
import { installShape } from './installShape';
import { installTransition } from './installTransition';
import { installSpeed } from './installSpeed';
import { installMainLayout } from './installMainLayout';
import { checkStalePacks, upgradePacks } from './packUpgrade';
import { watchProject } from './watchProject';
import { watchAllProjectsStatus } from './projectsWatch';
import {
  handleTranscribePost,
  handleTranscribeSse,
  handleTranscribeDelete,
  transcribeJobs,
} from './transcribeApi';
import {
  handleDenoisePost,
  handleDenoiseSse,
  handleDenoiseDelete,
  handleDenoiseRestore,
  denoiseJobs,
} from './denoiseApi';
import {
  handleRenderPost,
  handleRenderSse,
  handleRenderDelete,
  handleRenderReveal,
  renderJobs,
} from './renderApi';
import { handleOpenMaterialFolder } from './openMaterialFolder';
import {
  handleNormalizePost,
  handleNormalizeSse,
  handleNormalizeDelete,
  handleNormalizeRestore,
  handleNormalizeStatus,
  normalizeJobs,
} from './normalizeApi';
import {
  handlePreviewProxyStatus,
  handlePreviewProxyPost,
  handlePreviewProxySse,
  handlePreviewProxyDelete,
  previewProxyJobs,
} from './previewProxyApi';
import {
  handleLearningDiff,
  handleLearningApprove,
  handleLearningStatus,
  validateApproveRequest,
} from './learningApi';
import { instructionInbox, isAgentConnected, validateInstructionInput } from './instructionInbox';
import { validateStatusRequest, writeStatusStage } from './projectStatus';
import { handleMcpRequest } from './mcp/server';
import { markSelfWrite, isSelfWriting, clearSelfWrite } from './selfWrite';
import { handleEventsSse, handleEventsSync } from './eventsApi';

/** URL から必須クエリパラメータを取り出す。無ければ HttpError。 */
export function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    throw new HttpError(400, `クエリパラメータ "${name}" が必要です`);
  }
  return value;
}

/** アップロード受信用の一時ディレクトリ（プロジェクトと同一ボリューム＝rename で移動できる）。 */
function uploadTmpDir(root: string): string {
  return join(root, '.sme-upload-tmp');
}

/** /api/* のリクエストを処理する。 */
async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (url.pathname === '/api/ping') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/projects') {
    sendJson(res, 200, { root: root, projects: scanProjects(root) });
    return;
  }
  if (url.pathname === '/api/project') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const saveReq = validateSaveRequest(body);
      // writeFileSync が走る前にウィンドウをマークし、chokidar の change を suppress する。
      markSelfWrite(id);
      sendJson(res, 200, saveProjectToDir(dir, saveReq));
      return;
    }
    sendJson(res, 200, loadProjectFromDir(dir));
    return;
  }
  if (url.pathname === '/api/project/status') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const body = await readJsonBody(req);
    const { id, stage } = validateStatusRequest(body);
    const dir = resolveProjectDir(root, id);
    if (!existsSync(dir)) {
      throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
    }
    sendJson(res, 200, writeStatusStage(dir, stage));
    return;
  }
  if (url.pathname === '/api/video') {
    const id = requireParam(url, 'id');
    const file = requireParam(url, 'file');
    // file はベース名のみ許可（パス区切り・.. を弾く）。
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      throw new HttpError(400, `不正な動画ファイル名です: ${file}`);
    }
    const dir = resolveProjectDir(root, id);
    // public 配下に「外を指す symlink」が入り得る（外付け取り込み）ため、配信できるのは
    // videoConfig.ts のメイン動画とその軽量プロキシに限る。任意の symlink を外へ配信しない。
    const mainVideo = projectVideoFile(dir);
    if (mainVideo !== null && file !== mainVideo && file !== previewProxyName(mainVideo)) {
      throw new HttpError(400, `このプロジェクトのメイン動画ではありません: ${file}`);
    }
    // 軽量プレビュープロキシ（public/<base>.preview.mp4）があれば優先。重い HEVC の
    // ブラウザデコードによるメモリ膨張を避けるため。無ければ元動画へフォールバック。
    // ?v=（版トークン）が原本を指している間は原本を返し続け、開きっぱなしの <video> が
    // プロキシ生成完了の瞬間に壊れないようにする（再読込後の新 URL からプロキシへ切替）。
    const videoPath = resolveVideoPathForVersion(join(dir, 'public'), file, url.searchParams.get('v'));
    if (!existsSync(videoPath)) {
      throw new HttpError(404, `動画ファイルが見つかりません: public/${file}`);
    }
    serveVideo(res, videoPath, req.headers.range);
    return;
  }
  if (url.pathname === '/api/browse') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const roots = browseRoots();
    const path = url.searchParams.get('path');
    if (path === null || path === '') {
      sendJson(res, 200, { roots, path: null, parent: null, dirs: [], files: [], truncated: false });
      return;
    }
    const real = assertBrowsablePath(path, roots);
    sendJson(res, 200, listDirectory(real, roots));
    return;
  }
  if (url.pathname === '/api/create-project-link') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const name = requireParam(url, 'name');
    const target = assertBrowsablePath(requireParam(url, 'path'), browseRoots());
    precheckCreateProject(root, name, target);
    const probe = canCreateSymlink(() => probeSymlinkSupport(uploadTmpDir(root)));
    if (!probe.ok) throw new HttpError(400, probe.message);
    const { id } = createProjectLinked(root, { name, targetPath: target });
    triggerBackgroundInstall(resolveProjectDir(root, id));
    sendJson(res, 200, { id });
    return;
  }
  if (url.pathname === '/api/relink') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const target = assertBrowsablePath(requireParam(url, 'path'), browseRoots());
    const videoFile = projectVideoFile(dir);
    if (videoFile === null) throw new HttpError(500, 'videoConfig.ts を読み取れませんでした');
    const vc = parseVideoConfigStatic(readFileSync(join(dir, 'src', 'videoConfig.ts'), 'utf8'));
    const result = relinkVideo(
      dir,
      { targetPath: target, videoFile, force: url.searchParams.get('force') === '1' },
      {
        fps: vc.fps,
        durationFrames: vc.durationFrames,
        width: vc.resolution.width,
        height: vc.resolution.height,
      },
    );
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/create-project') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const name = requireParam(url, 'name');
    const videoName = requireParam(url, 'video');
    // 数GBを受け切ってから弾く無駄を避けるため、名前・拡張子・重複は受信前にチェックする。
    precheckCreateProject(root, name, videoName);
    // ボディはメモリに載せず一時ファイルへ直接書く。上限は HARNESS_MAX_UPLOAD_BYTES（既定32GiB）で
    // ディスク枯渇 DoS を防ぐ。Content-Length があれば受信前に弾く。
    const maxUpload = resolveMaxUploadBytes();
    assertContentLengthWithin(req, maxUpload);
    // createProject 成功時は rename で移動済みなので finally の削除は no-op。
    const tmpPath = await streamBodyToTempFile(req, uploadTmpDir(root), maxUpload);
    let id: string;
    try {
      ({ id } = createProject(root, { name, videoName, videoTmpPath: tmpPath }));
    } finally {
      rmSync(tmpPath, { force: true });
    }
    // プロジェクト内で直接 `npm run dev` 等を実行する時に node_modules 不在で詰まらないよう、
    // レスポンスをブロックせずバックグラウンドで npm install を開始する（Editor でのプレビュー自体には不要）。
    triggerBackgroundInstall(resolveProjectDir(root, id));
    sendJson(res, 200, { id, projects: scanProjects(root) });
    return;
  }
  if (url.pathname === '/api/upload-material') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const kind = requireParam(url, 'kind');
    const name = requireParam(url, 'name');
    if (!isUploadKind(kind)) {
      throw new HttpError(400, `不正な素材種別です: ${kind}`);
    }
    const dir = resolveProjectDir(root, id);
    if (!existsSync(dir)) {
      throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
    }
    // 拡張子不正は受信前に弾く（大容量ボディを受け切ってから 400 にしない）。
    sanitizeUploadName(kind, name);
    const maxUpload = resolveMaxUploadBytes();
    assertContentLengthWithin(req, maxUpload);
    const tmpPath = await streamBodyToTempFile(req, uploadTmpDir(root), maxUpload);
    let file: string;
    try {
      ({ file } = saveMaterialFile(dir, kind, name, tmpPath));
    } finally {
      rmSync(tmpPath, { force: true });
    }
    // ライブラリ一覧・assetVersions はプロジェクト読込と同じ計算で返す
    // （クライアントはこの応答で open 状態の該当フィールドだけ差し替える）。
    const loaded = loadProjectFromDir(dir);
    sendJson(res, 200, {
      file,
      seLibrary: loaded.seLibrary,
      imageLibrary: loaded.imageLibrary,
      bgmLibrary: loaded.bgmLibrary,
      videoLibrary: loaded.videoLibrary,
      assetVersions: loaded.assetVersions,
    });
    return;
  }
  if (url.pathname === '/api/asset') {
    const id = requireParam(url, 'id');
    const path = requireParam(url, 'path');
    const dir = resolveProjectDir(root, id);
    const assetPath = resolvePublicAsset(dir, path);
    serveAsset(res, assetPath, req.headers.range);
    return;
  }
  if (url.pathname === '/api/telop-component') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const js = await bundleTelopComponent(dir);
    sendText(res, 200, js, 'text/javascript; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/insert-image-component') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    try {
      const js = await bundleInsertImageComponent(dir);
      sendText(res, 200, js, 'text/javascript; charset=utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }
  if (url.pathname === '/api/insert-video-component') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    try {
      const js = await bundleInsertVideoComponent(dir);
      sendText(res, 200, js, 'text/javascript; charset=utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }
  if (url.pathname === '/api/convert-burned-in') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    sendJson(res, 200, convertBurnedInProject(dir));
    return;
  }
  if (url.pathname === '/api/install-telop-pack') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installTelopPack(dir));
    return;
  }
  if (url.pathname === '/api/install-video-insert') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installVideoInsert(dir));
    return;
  }
  if (url.pathname === '/api/install-bgm') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installBgm(dir));
    return;
  }
  if (url.pathname === '/api/install-shape') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installShape(dir));
    return;
  }
  if (url.pathname === '/api/install-transition') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installTransition(dir));
    return;
  }
  if (url.pathname === '/api/install-speed') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installSpeed(dir));
    return;
  }
  if (url.pathname === '/api/install-main-layout') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, installMainLayout(dir));
    return;
  }
  if (url.pathname === '/api/pack-status') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, { stale: checkStalePacks(dir) });
    return;
  }
  if (url.pathname === '/api/pack-upgrade') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    sendJson(res, 200, upgradePacks(dir, checkStalePacks(dir)));
    return;
  }

  if (url.pathname === '/api/events') {
    // GET /api/events(?id=<projectId>) — SSE 1 本統合エンドポイント。
    // id 無し = ホーム画面用（projects チャネルのみ）。id 有り = エディタ画面用（全チャネル）。
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = url.searchParams.get('id');
    handleEventsSse(req, res, root, id !== null && id !== '' ? id : null);
    return;
  }
  if (url.pathname === '/api/events/sync') {
    // GET /api/events/sync?id=<projectId>&ch=<channel> — バス接続確立「後」にマウント/
    // リマウントしたコンシューマが初期スナップショットを取り逃さないためのキャッチアップ用。
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = requireParam(url, 'id');
    const ch = requireParam(url, 'ch');
    sendJson(res, 200, handleEventsSync(id, ch));
    return;
  }

  // deprecated: 従来の 8 SSE エンドポイント（/api/projects/watch・/api/watch・
  // /api/instructions/stream・/api/{render,denoise,normalize,preview-proxy,transcribe} の
  // GET）は後方互換・既存テスト温存のため残す。新規クライアントは /api/events（SSE 1本統合）
  // を使うこと（2026-07-23 docs/specs/2026-07-23-sse-unified-connection.md）。
  if (url.pathname === '/api/transcribe') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      handleTranscribePost(req, res, id, dir, url.searchParams.get('force') === '1');
      return;
    }
    if (method === 'GET') {
      handleTranscribeSse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handleTranscribeDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/denoise/restore') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    assertVideoProcessingAllowed(dir, 'ノイズ除去の復元');
    handleDenoiseRestore(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/denoise') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      assertVideoProcessingAllowed(dir, 'ノイズ除去');
      await handleDenoisePost(req, res, id, dir, url.searchParams.get('force') === '1');
      return;
    }
    if (method === 'GET') {
      handleDenoiseSse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handleDenoiseDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/materials/open-folder') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    handleOpenMaterialFolder(res, dir, requireParam(url, 'kind'));
    return;
  }
  if (url.pathname === '/api/render/reveal') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    handleRenderReveal(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/render') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      // 外付け未接続のまま数時間かけて失敗するのを防ぐ（開始前に弾く）。
      assertSourceAvailable(dir);
      await handleRenderPost(req, res, id, dir, url.searchParams.get('force') === '1');
      return;
    }
    if (method === 'GET') {
      handleRenderSse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handleRenderDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/learning/diff') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    sendJson(res, 200, handleLearningDiff(dir));
    return;
  }
  if (url.pathname === '/api/learning/approve') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const body = await readJsonBody(req);
    const approveReq = validateApproveRequest(body);
    const dir = resolveProjectDir(root, approveReq.projectId);
    sendJson(res, 200, handleLearningApprove(dir, approveReq));
    return;
  }
  if (url.pathname === '/api/learning/status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    sendJson(res, 200, handleLearningStatus());
    return;
  }
  if (url.pathname === '/api/normalize/status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    handleNormalizeStatus(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/normalize/restore') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    assertVideoProcessingAllowed(dir, '音量調整の復元');
    handleNormalizeRestore(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/normalize') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      assertVideoProcessingAllowed(dir, '音量調整');
      await handleNormalizePost(req, res, id, dir, url.searchParams.get('force') === '1');
      return;
    }
    if (method === 'GET') {
      handleNormalizeSse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handleNormalizeDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/preview-proxy/status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    handlePreviewProxyStatus(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/preview-proxy') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      handlePreviewProxyPost(req, res, id, dir, url.searchParams.get('force') === '1');
      return;
    }
    if (method === 'GET') {
      handlePreviewProxySse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handlePreviewProxyDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/config') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    // クライアント向けの起動設定。tutorialEnabled=false は e2e が初回チュートリアルの
    // 自動開始で汚染されないためのスイッチ（playwright.config が SME_TUTORIAL=0 を渡す）。
    // autoSaveDefaultEnabled=false も同様に e2e 用（playwright.config が SME_AUTO_SAVE=0 を渡す）。
    // ユーザーが明示的にトグルを操作済み（localStorage 保存済み）のときはこの既定値では
    // 上書きしない（クライアント側 hasExplicitAutoSavePref が判定）。
    // autoSaveDelayMs は自動保存の待ち時間（既定 4000ms）。専用 e2e はより短い値へ変更したい
    // 場合クエリ `autoSaveDelayMsForTest` で個別上書きできる（サーバ設定より優先）。
    sendJson(res, 200, {
      tutorialEnabled: process.env.SME_TUTORIAL !== '0',
      autoSaveDefaultEnabled: process.env.SME_AUTO_SAVE !== '0',
      autoSaveDelayMs: process.env.SME_AUTO_SAVE_DELAY_MS
        ? Number(process.env.SME_AUTO_SAVE_DELAY_MS)
        : undefined,
    });
    return;
  }
  if (url.pathname === '/api/agent-status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    // AI タブの接続表示用。MCP 消費者（AI エージェント）の在席シグナルを返す。
    // ?id=<projectId> 指定時はその動画の専属在席（dedicated）も含める（既存フィールドは維持・追加のみ＝後方互換）。
    const id = url.searchParams.get('id') ?? undefined;
    const status = instructionInbox.agentStatus(id);
    sendJson(res, 200, { ...status, connected: isAgentConnected(status, Date.now()) });
    return;
  }
  if (url.pathname === '/api/instructions') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const body = await readJsonBody(req);
    const input = validateInstructionInput(body);
    const dir = resolveProjectDir(root, input.projectId);
    let record;
    try {
      record = instructionInbox.enqueue({
        projectId: input.projectId,
        projectDir: dir,
        text: input.text,
        context: input.context,
      });
    } catch (err) {
      // 永続化書き込み失敗（ディスク容量不足等）。「受付成功」と偽らず 500 を返す。
      console.error('[sme] 受け箱への保存に失敗しました:', err);
      sendJson(res, 500, { error: 'inbox-save-failed' });
      return;
    }
    sendJson(res, 200, record);
    return;
  }
  if (url.pathname === '/api/instructions/abort') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const body = await readJsonBody(req);
    const id =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).id
        : undefined;
    if (typeof id !== 'string' || id === '') {
      throw new HttpError(400, '打ち切りリクエストの id が必要です');
    }
    const aborted = instructionInbox.abort(id);
    sendJson(res, 200, { ok: aborted !== null });
    return;
  }
  if (url.pathname === '/api/instructions/stream') {
    // deprecated: /api/events(?id=) の claude チャネルへ統合済み。
    const id = requireParam(url, 'id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const safeWrite = (chunk: string): void => {
      if (!res.writableEnded) res.write(chunk);
    };
    safeWrite(`data: ${JSON.stringify({ type: 'open' })}\n\n`);
    // 接続時に現在のレコードをまとめて流す（画面の履歴を初期化）。
    for (const record of instructionInbox.list(id)) {
      safeWrite(`data: ${JSON.stringify({ type: 'update', record })}\n\n`);
    }
    // 以降の変化を購読。該当 projectId のものだけ送る。
    const unsubscribe = instructionInbox.subscribe((record) => {
      if (record.projectId === id) {
        safeWrite(`data: ${JSON.stringify({ type: 'update', record })}\n\n`);
      }
    });
    const heartbeat = setInterval(() => safeWrite(`: heartbeat\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
    return;
  }
  if (url.pathname === '/api/watch') {
    // deprecated: /api/events(?id=) の watch チャネルへ統合済み。
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // SSE（Server-Sent Events）レスポンスを開く。
    // X-Accel-Buffering は nginx 等のプロキシでのバッファリング無効化（開発用途では効かないが
    // 将来サーバ越しで使うときの予防）。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // ストリームが終了済みのときに write すると ERR_STREAM_WRITE_AFTER_END になるためガード。
    const safeWrite = (chunk: string): void => {
      if (!res.writableEnded) res.write(chunk);
    };
    // 初回 open イベントでクライアントへ接続確立を伝える。
    safeWrite(`data: ${JSON.stringify({ type: 'open' })}\n\n`);
    console.log(`[sme] /api/watch open: id=${id}`);
    // 25 秒ごとの heartbeat。長時間アイドルでブラウザ・中継器が接続を切らないようにする。
    let heartbeat: NodeJS.Timeout | null = null;
    let stop: (() => void) | null = null;
    try {
      heartbeat = setInterval(() => {
        // コメント行は SSE 仕様でクライアントへ届くがイベントとして処理されない。
        safeWrite(`: heartbeat\n\n`);
      }, 25_000);
      stop = watchProject(
        dir,
        () => {
          safeWrite(`data: ${JSON.stringify({ type: 'change' })}\n\n`);
        },
        { isSelfWrite: () => isSelfWriting(id) },
      );
    } catch (err) {
      // writeHead 後なので上流 catch では JSON エラーを返せない。ログだけ残して接続を閉じる。
      console.error('[sme] /api/watch 初期化失敗:', err);
      if (heartbeat !== null) clearInterval(heartbeat);
      if (stop !== null) stop();
      res.end();
      return;
    }
    // クライアントが EventSource.close() するか、ページ遷移／タブを閉じるとここに来る。
    req.on('close', () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (stop !== null) stop();
      // SSE 切断時に自己保存ウィンドウをクリアする。
      // 残ったままだと次の SSE 接続（別テスト等）での外部書き換えを誤って suppress してしまう。
      clearSelfWrite(id);
      res.end();
      console.log(`[sme] /api/watch close: id=${id}`);
    });
    return;
  }
  if (url.pathname === '/api/projects/watch') {
    // deprecated: /api/events の projects チャネルへ統合済み。
    // ホーム画面（プロジェクト未選択）でのライブ更新用 SSE。root 配下の全プロジェクトの
    // .sme/status.json と out/video.mp4 を監視し、変化したプロジェクトのステータス差分を配信する。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const safeWrite = (chunk: string): void => {
      if (!res.writableEnded) res.write(chunk);
    };
    safeWrite(`data: ${JSON.stringify({ type: 'open' })}\n\n`);
    console.log('[sme] /api/projects/watch open');
    let heartbeat: NodeJS.Timeout | null = null;
    let stop: (() => void) | null = null;
    try {
      heartbeat = setInterval(() => {
        safeWrite(`: heartbeat\n\n`);
      }, 25_000);
      stop = watchAllProjectsStatus(root, (event) => {
        safeWrite(`data: ${JSON.stringify({ type: 'status', ...event })}\n\n`);
      });
    } catch (err) {
      console.error('[sme] /api/projects/watch 初期化失敗:', err);
      if (heartbeat !== null) clearInterval(heartbeat);
      if (stop !== null) stop();
      res.end();
      return;
    }
    req.on('close', () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (stop !== null) stop();
      res.end();
      console.log('[sme] /api/projects/watch close');
    });
    return;
  }
  throw new HttpError(404, `API が見つかりません: ${url.pathname}`);
}

/** Harness Editor のローカルサーバを Vite 開発サーバへ組み込む Vite プラグイン。 */
export function smeServer(): Plugin {
  return {
    name: 'sme-server',
    // configureServer 内で直接 use するとミドルウェアは Vite 内部処理より先に走る。
    configureServer(server) {
      const root = getProjectRoot();
      console.log(`[sme] プロジェクトルート: ${root}`);
      // 受け箱の永続化をアタッチ（.sme-inbox.json）。同じフォルダで別のエディタが既に
      // 永続化を握っている場合（pidfile ロック取得失敗）はメモリのみで動作し続ける。
      const attach = instructionInbox.attachPersistence(join(root, '.sme-inbox.json'), {
        resolveProjectDir: (projectId) => {
          try {
            return resolveProjectDir(root, projectId);
          } catch {
            return null;
          }
        },
      });
      if (!attach.persisted) {
        console.warn('[sme] 受け箱の永続化を無効化しました（同じフォルダで別のエディタが起動中です）');
      }
      // 前回クラッシュ等で残ったアップロード一時ファイル（数GBになりうる）を起動時に掃除する。
      rmSync(uploadTmpDir(root), { recursive: true, force: true });
      // Vite サーバ停止時に進行中の subprocess を全 kill する。
      server.httpServer?.on('close', () => {
        transcribeJobs.killAll();
        denoiseJobs.killAll();
        normalizeJobs.killAll();
        renderJobs.killAll();
        previewProxyJobs.killAll();
        instructionInbox.releasePersistence();
      });
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');
        // このミドルウェアは Vite 内部の Host チェックより先に走るため、
        // DNS リバインディング/CSRF 対策として /api・/mcp は自前でローカル起源を検証する。
        if (url.pathname === '/mcp' || rawUrl.startsWith('/api/')) {
          if (!isAllowedLocalRequest(req.headers)) {
            sendJson(res, 403, { error: 'ローカル以外からのアクセスは許可されていません' });
            return;
          }
        }
        if (url.pathname === '/mcp') {
          // POST のみ本文を読む。GET(SSE)/DELETE は本文なし。
          const method = (req.method ?? 'GET').toUpperCase();
          const run = async (): Promise<void> => {
            const body = method === 'POST' ? await readJsonBody(req) : undefined;
            await handleMcpRequest(req, res, instructionInbox, body);
          };
          run().catch((err: unknown) => {
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof Error ? err.message : String(err);
            console.error('[sme] MCPエラー:', err);
            if (!res.headersSent) sendJson(res, status, { error: message });
            else if (!res.writableEnded) res.end();
          });
          return;
        }
        if (!rawUrl.startsWith('/api/')) {
          next();
          return;
        }
        handleApi(req, res, url, root).catch((err: unknown) => {
          const status = err instanceof HttpError ? err.status : 500;
          const message = err instanceof Error ? err.message : String(err);
          if (status >= 500) console.error('[sme] APIエラー:', err);
          sendJson(res, status, { error: message });
        });
      });
    },
  };
}
