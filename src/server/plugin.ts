import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { HttpError, sendJson, sendText } from './http';
import { getProjectRoot, resolveProjectDir, resolvePublicAsset } from './projectRoot';
import { isHarnessProject, scanProjects } from './scanProjects';
import { parseVideoConfigStatic } from '../core';
import { loadProjectFromDir } from './loadProjectFiles';
import { isUploadKind, materialRelPath, sanitizeUploadName, saveMaterialFile } from './uploadMaterial';
import { scanMaterialUsage } from './materialUsage';
import { findBusyJobs } from './projectBusy';
import { PROJECT_JOB_MANAGERS, killAllProjectJobs } from './jobRegistries';
import { emptyTrash, listTrash, moveToTrash, restoreFromTrash } from './trashStore';
import { makeAssetKey, type AssetKind } from '../shared/assetKey';
import { createProject, createProjectLinked, precheckCreateProject } from './createProject';
import { assertBrowsablePath, browseRoots, canCreateSymlink, listDirectory } from './browsePaths';
import {
  assertSourceAvailable,
  assertVideoProcessingAllowed,
  projectVideoFile,
} from './videoLink';
import { relinkVideo } from './relinkVideo';
import { describeCopyReason, planImport, type CopyReason } from './autoLinkImport';
import { convertProjectToLink, describeLinkMissReason, findConvertCandidate } from './convertToLink';
import type { ImportOutcome } from '../shared/types';
import { probeSymlinkSupport } from './symlinkProbe';
import { streamBodyToTempFile, assertContentLengthWithin, resolveMaxUploadBytes } from './streamUpload';
import { readJsonBody } from './readBody';
import { triggerBackgroundInstall } from './backgroundInstall';
import { saveProjectToDir, validateSaveRequest } from './saveProject';
import { serveVideo } from './serveVideo';
import { resolveTrashVideoPath } from './trashVideo';
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
} from './transcribeApi';
import {
  handleDenoisePost,
  handleDenoiseSse,
  handleDenoiseDelete,
  handleDenoiseRestore,
} from './denoiseApi';
import {
  handleRenderPost,
  handleRenderSse,
  handleRenderDelete,
  handleRenderReveal,
} from './renderApi';
import { handleOpenMaterialFolder, openFolder } from './openMaterialFolder';
import {
  handleNormalizePost,
  handleNormalizeSse,
  handleNormalizeDelete,
  handleNormalizeRestore,
  handleNormalizeStatus,
} from './normalizeApi';
import {
  handlePreviewProxyStatus,
  handlePreviewProxyPost,
  handlePreviewProxySse,
  handlePreviewProxyDelete,
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

/** realpath 化（解決できなければ与えられたパスをそのまま使う）。 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 素材ライブラリ一覧＋assetVersions（クライアントの patchLibraries が受け取る形）。
 * プロジェクトを読めない場合は null（呼び出し側はパッチ無しで応答する）。
 */
function librariesPatch(dir: string): Record<string, unknown> | null {
  try {
    const loaded = loadProjectFromDir(dir);
    return {
      seLibrary: loaded.seLibrary,
      imageLibrary: loaded.imageLibrary,
      bgmLibrary: loaded.bgmLibrary,
      videoLibrary: loaded.videoLibrary,
      assetVersions: loaded.assetVersions,
    };
  } catch {
    return null;
  }
}

/** アップロード受信用の一時ディレクトリ（プロジェクトと同一ボリューム＝rename で移動できる）。 */
function uploadTmpDir(root: string): string {
  return join(root, '.sme-upload-tmp');
}

/** /api/* のリクエストを処理する（ルート単位のテストのため export）。 */
export async function handleApi(
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
    if (method === 'DELETE') {
      if (!existsSync(dir)) {
        throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
      }
      // id='.'・''・'foo/..' などはルート自身に解決する。ルートごとゴミ箱へ入れると
      // 全プロジェクトが一度に消えるため、明示的に拒否する。
      if (resolve(root, id) === resolve(root)) {
        throw new HttpError(400, 'プロジェクト置き場そのものは削除できません');
      }
      // ルート直下にある無関係なディレクトリ（作業フォルダ・バックアップ等）を
      // 削除 API で消せないようにする。消せるのは一覧に出るプロジェクトだけ。
      if (!isHarnessProject(dir)) {
        throw new HttpError(400, `ハーネス形式のプロジェクトではありません: ${id}`);
      }
      // 書き出し・文字起こし等が走っている最中にディレクトリごと rename すると、
      // 実行中プロセスが消えたパスへ書き続ける。終わるまで削除させない。
      // pty セッション（AI ターミナル）はここでは見ない: 単一セッション設計で cwd は
      // プロジェクト置き場（root）であり、特定プロジェクトに紐づかない。これを busy 条件に
      // 入れると、ターミナルを開いている間はどのプロジェクトも削除できなくなる。
      // 一方 AI 指示の受け箱は projectId 単位なので busy に数える（再レビュー I-1）:
      // processing＝エージェントがそのプロジェクトを編集中で、ディレクトリごと rename すると
      // 消えたパスへ書き続ける。pending は誰も取っていないので削除を止めない。
      // ジョブ 5 種は `jobRegistries.ts` の正本から導出する（killAll と同じ列挙・M-4）。
      const busy = findBusyJobs(id, {
        ...PROJECT_JOB_MANAGERS,
        aiInstruction: {
          get: (projectId) =>
            instructionInbox.hasProcessing(projectId) ? { phase: 'processing' } : undefined,
        },
      });
      if (busy.length > 0) {
        sendJson(res, 409, { error: 'busy', jobs: busy });
        return;
      }
      // moveToTrash には検証済みの相対パスだけを渡す（クライアント由来の id を
      // そのまま join させない）。root 自体が symlink 経由の場合に備え、
      // resolveProjectDir が返す実体パスを基準に相対化する。
      const realRoot = safeRealpath(root);
      const rel = relative(realRoot, dir);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new HttpError(400, `不正なプロジェクトパスです: ${id}`);
      }
      // プロジェクト本体を <root>/.trash/ へ tombstone として移動する（メイン動画もこれで消える）。
      const entry = moveToTrash(realRoot, rel, 'project');
      // 削除が通った瞬間に、そのプロジェクト宛の pending 指示を同一プロセス内で失効させる
      // （再レビュー I-1）。残すと直後の poll が消えたパス宛の指示を配送してしまい、
      // その stale な processing が hasProcessing を真にして再削除まで塞ぐ。
      instructionInbox.failPendingFor(id);
      sendJson(res, 200, { entry, projects: scanProjects(root) });
      return;
    }
    sendJson(res, 200, loadProjectFromDir(dir));
    return;
  }
  if (url.pathname === '/api/project/reveal') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    // 開く先は **id から導出**する（クライアントから生パスを受け取らない）。
    // resolveProjectDir が文字列封じ込め＋realpath の二段でルート外を弾く。
    const dir = resolveProjectDir(root, id);
    if (!existsSync(dir)) {
      throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
    }
    // 不変条件: **開いてよいのは一覧に出るプロジェクトのフォルダだけ**（レビュー I-1）。
    // resolveProjectDir はルート外への脱出しか見ないので、それだけだと
    // `id=proj/public/foo.command` や `.app` バンドルのような**ルート配下の任意パス**を
    // OS の open に渡せてしまう。open はディレクトリなら Finder で開くが、ファイルなら
    // 「起動」＝実行になる。兄弟ルート（DELETE /api/project）と同じ強さに揃える。
    const revealRel = relative(safeRealpath(root), dir);
    if (
      revealRel === '' ||
      isAbsolute(revealRel) ||
      // '..' 単体は区切りを含まないので includes('/') では落ちない。ルート自身の親を
      // 指す形は必ず弾く（M-5。resolveProjectDir も弾くが、検査を相手の実装に委ねない）。
      revealRel === '..' ||
      revealRel.startsWith('..') ||
      revealRel.includes('/') ||
      revealRel.includes('\\')
    ) {
      throw new HttpError(400, `プロジェクトのフォルダではありません: ${id}`);
    }
    if (!statSync(dir).isDirectory() || !isHarnessProject(dir)) {
      throw new HttpError(400, `ハーネス形式のプロジェクトではありません: ${id}`);
    }
    openFolder(dir, process.platform);
    sendJson(res, 200, { ok: true });
    return;
  }
  // 既存のコピー取り込みプロジェクトを、外付け等の同一実体へのリンクへ張り替える（容量回収）。
  // candidate は「探すだけ」、convert が破壊的な置換。**候補パスはどちらもサーバの探索結果**で、
  // クライアントから生パスを受け取らない（受け取ると任意の実体を指す symlink を作らせられる）。
  if (url.pathname === '/api/project/link-candidate' || url.pathname === '/api/project/convert-to-link') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (!existsSync(dir) || !isHarnessProject(dir)) {
      throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
    }
    if (url.pathname === '/api/project/link-candidate') {
      const outcome = findConvertCandidate(root, dir);
      // 見つからなかった理由は UI がそのまま出せる日本語で返す（クライアントで
      // reason を日本語へ翻訳し直すと、理由が増えたとき片側だけ古くなる）。
      sendJson(
        res,
        200,
        outcome.matched ? outcome : { ...outcome, message: describeLinkMissReason(outcome.reason) },
      );
      return;
    }
    // 書き出し・文字起こし等が走っている最中にメイン動画を差し替えない
    // （削除と同じ busy 判定を使う。実行中プロセスは消えた実体へ書き続ける）。
    const busy = findBusyJobs(id, PROJECT_JOB_MANAGERS);
    if (busy.length > 0) {
      sendJson(res, 409, { error: 'busy', jobs: busy });
      return;
    }
    const result = convertProjectToLink(root, dir);
    sendJson(res, 200, { ...result, projects: scanProjects(root) });
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
    // ユーザーが作成モーダルで「コピーして取り込む」を明示した場合は自動リンク化しない。
    const preferCopy = url.searchParams.get('copy') === '1';
    // 数GBを受け切ってから弾く無駄を避けるため、名前・拡張子・重複は受信前にチェックする。
    precheckCreateProject(root, name, videoName);
    // ボディはメモリに載せず一時ファイルへ直接書く。上限は HARNESS_MAX_UPLOAD_BYTES（既定32GiB）で
    // ディスク枯渇 DoS を防ぐ。Content-Length があれば受信前に弾く。
    const maxUpload = resolveMaxUploadBytes();
    assertContentLengthWithin(req, maxUpload);
    // createProject 成功時は rename で移動済みなので finally の削除は no-op。
    const tmpPath = await streamBodyToTempFile(req, uploadTmpDir(root), maxUpload);
    let id: string;
    let imported: ImportOutcome;
    try {
      // 受信後にマッチングを試みる（受信前に探索すると、見つからない時の待ち時間が
      // まるごと作成の遅延になる）。同一実体が起点配下に在れば実体コピーをやめて
      // 既存のリンク取り込みへ切り替える。曖昧なら必ずコピーへ落ちる。
      const plan = planImport({ root, tmpPath, videoName, preferCopy });
      let linked: { id: string; imported: ImportOutcome } | null = null;
      if (plan.link) {
        try {
          // 探索結果のパスでも、取り込みの入口の封じ込め（起点配下のみ・realpath 解決）を
          // 必ず通す。ここを通さないと「探索の実装が正しい」ことに安全性が依存する。
          const target = assertBrowsablePath(plan.target, browseRoots());
          const created = createProjectLinked(root, { name, targetPath: target });
          linked = {
            id: created.id,
            imported: { linked: true, target, message: `外付けの実体にリンクしました（コピーなし）: ${target}` },
          };
        } catch (err) {
          // 判断（planImport）だけでなく**実行段**の失敗もコピーへ落とす（レビュー I-3）。
          // 数GBを受け切った後の最後の 1 手で 500 を返すと、取り込みが丸ごと無駄になる。
          // 一時ファイルはこの時点でまだ消していない（削除は下の finally）ので、
          // そのままコピーで作成できる。createProjectLinked は自身の失敗で作りかけの
          // フォルダごと巻き戻すため、同じ名前でコピー作成し直せる。
          console.warn(`[sme] リンク取り込みに失敗したためコピーへ切り替えます: ${(err as Error).message}`);
        }
      }
      if (linked !== null) {
        ({ id, imported } = linked);
      } else {
        const reason: CopyReason = plan.link ? 'link-failed' : plan.reason;
        ({ id } = createProject(root, { name, videoName, videoTmpPath: tmpPath }));
        imported = { linked: false, reason, message: describeCopyReason(reason) };
      }
    } finally {
      rmSync(tmpPath, { force: true });
    }
    // プロジェクト内で直接 `npm run dev` 等を実行する時に node_modules 不在で詰まらないよう、
    // レスポンスをブロックせずバックグラウンドで npm install を開始する（Editor でのプレビュー自体には不要）。
    triggerBackgroundInstall(resolveProjectDir(root, id));
    sendJson(res, 200, { id, imported, projects: scanProjects(root) });
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
  if (url.pathname === '/api/material') {
    if (method !== 'DELETE') {
      throw new HttpError(405, 'このエンドポイントは DELETE のみ対応します');
    }
    const id = requireParam(url, 'id');
    const kind = requireParam(url, 'kind');
    // アップロード時（sanitizeUploadName）と同じ NFC 正規化。macOS の濁点分解（NFD）で
    // 送られてきた名前を、NFC で保存されている実体・ライブラリ一覧と突き合わせられるようにする。
    const file = requireParam(url, 'file').normalize('NFC');
    if (!isUploadKind(kind)) {
      throw new HttpError(400, `不正な素材種別です: ${kind}`);
    }
    // image/video 素材はサブディレクトリ相対パスを含み得るため '/' は許可し、
    // ディレクトリ脱出（..・先頭スラッシュ・バックスラッシュ）だけ弾く。
    if (file.includes('..') || file.startsWith('/') || file.includes('\\')) {
      throw new HttpError(400, `不正なファイル名です: ${file}`);
    }
    const dir = resolveProjectDir(root, id);
    // メイン動画は削除対象外（プロジェクト削除でのみ消える）。プレビュープロキシも同様。
    const mainVideo = projectVideoFile(dir);
    if (kind === 'video' && mainVideo === null) {
      // videoConfig.ts を読めないと「メイン動画かどうか」を判定できない。判定できないまま
      // 通すとメイン動画そのものを削除し得るため、fail-open せず保留する。
      sendJson(res, 409, { error: '動画設定を読めないため削除を保留します（src/videoConfig.ts を確認してください）' });
      return;
    }
    if (kind === 'video' && mainVideo !== null && (file === mainVideo || file === previewProxyName(mainVideo))) {
      throw new HttpError(400, 'メイン動画は削除できません（プロジェクトの削除でのみ消えます）');
    }
    // 削除できるのは「このプロジェクトの素材ライブラリに載っているファイル」だけ。
    // public 配下の任意ファイル（設定・書き出し・他人の置いたもの）を削除 API で
    // 消せないようにする最後の絞り込み。
    let before: ReturnType<typeof loadProjectFromDir>;
    try {
      before = loadProjectFromDir(dir);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // プロジェクトを読めない＝素材かどうか確かめられない。500 で落とさず削除を保留する
      // （走査失敗と同じ「未使用と誤認しない」扱い）。
      sendJson(res, 409, { error: 'scan-failed' });
      return;
    }
    const library: Record<string, string[]> = {
      se: before.seLibrary,
      image: before.imageLibrary,
      bgm: before.bgmLibrary,
      video: before.videoLibrary,
    };
    // NFC 同士の突合は macOS（APFS/HFS+ が NFD 寄りの名前を返しうる）を想定した正規化。
    if (!(library[kind] ?? []).some((f) => f.normalize('NFC') === file)) {
      throw new HttpError(400, `このプロジェクトの素材ではありません: ${file}`);
    }
    // 素材の実パスを realpath で封じ込め（serveAsset と同じ防御）。末端 symlink だけでなく
    // 親ディレクトリが外を指す symlink のケースもここで弾く。
    resolvePublicAsset(dir, relative('public', materialRelPath(kind, file)));
    // 走査は force でも必ず行う（force は「使用中でも削除する」の意味であって
    // 「数えない」ではない）。数えた結果は 200 応答の usedCount としてそのまま返し、
    // クライアントの完了通知に使う。
    const force = url.searchParams.get('force') === '1';
    const usage = scanMaterialUsage(dir, makeAssetKey(kind as AssetKind, file));
    // 走査失敗は「未使用」と誤認せず削除を保留する。**force でも突破させない** —
    // force は「画面に出た使用件数を承知のうえで消す」という意思表示であって、
    // 「参照が分からないまま消す」の承認ではない（走査が失敗した時点で、利用者は
    // 何件使われているかを一度も見せられていない）。
    if (!usage.ok) {
      sendJson(res, 409, { error: 'scan-failed' });
      return;
    }
    if (!force && usage.count > 0) {
      sendJson(res, 409, { error: 'in-use', count: usage.count });
      return;
    }
    markSelfWrite(id);
    const entry = moveToTrash(dir, materialRelPath(kind, file), kind);
    const loaded = loadProjectFromDir(dir);
    sendJson(res, 200, {
      entry,
      // サーバが数えられた使用箇所数（走査できなかった場合は null）。
      usedCount: usage.ok ? usage.count : null,
      seLibrary: loaded.seLibrary,
      imageLibrary: loaded.imageLibrary,
      bgmLibrary: loaded.bgmLibrary,
      videoLibrary: loaded.videoLibrary,
      assetVersions: loaded.assetVersions,
    });
    return;
  }
  if (url.pathname === '/api/trash') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = url.searchParams.get('id');
    const base = id === null || id === '' ? root : resolveProjectDir(root, id);
    sendJson(res, 200, { entries: listTrash(base) });
    return;
  }
  if (url.pathname === '/api/trash/video') {
    // ゴミ箱カードのサムネイル。配信できるのは tombstone 内のメイン動画だけで、
    // パスはクライアントから受け取らず entryId からサーバが導出する（trashVideo.ts）。
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const videoPath = resolveTrashVideoPath(root, requireParam(url, 'entryId'));
    serveVideo(res, videoPath, req.headers.range);
    return;
  }
  if (url.pathname === '/api/trash/restore' || url.pathname === '/api/trash/empty') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null) {
      throw new HttpError(400, 'リクエストボディがオブジェクトではありません');
    }
    const b = body as Record<string, unknown>;
    const id = typeof b['id'] === 'string' && b['id'] !== '' ? b['id'] : null;
    const entryId = typeof b['entryId'] === 'string' && b['entryId'] !== '' ? b['entryId'] : undefined;
    const base = id === null ? root : resolveProjectDir(root, id);
    if (id !== null) markSelfWrite(id);
    let result: Record<string, unknown>;
    if (url.pathname === '/api/trash/restore') {
      if (entryId === undefined) throw new HttpError(400, 'entryId が必要です');
      result = { ...restoreFromTrash(base, entryId) };
    } else {
      // 「全件消す」は暗黙（entryId 省略）ではなくワイヤ上で明示させる。
      // 省略＝全消しだと、entryId の組み立てを1箇所間違えるだけでゴミ箱が全部消える。
      const all = b['all'] === true;
      if (entryId === undefined && !all) {
        throw new HttpError(400, 'entryId（1件削除）または all:true（全件削除）が必要です');
      }
      if (entryId !== undefined && all) {
        throw new HttpError(400, 'entryId と all:true は同時に指定できません');
      }
      result = { ...emptyTrash(base, entryId) };
    }
    // 素材ゴミ箱（id あり）の操作はライブラリ構成を変える。クライアントが
    // プロジェクト全体を reload せず部分反映できるよう、削除 API と同じパッチを載せる
    // （全体 reload は編集中の未保存状態を捨ててしまう）。
    if (id !== null) {
      const patch = librariesPatch(base);
      if (patch !== null) result = { ...result, ...patch };
    }
    sendJson(res, 200, result);
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
  // を使うこと（SSE はブラウザの同一オリジン接続上限を食うため 1 本へ統合する）。
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
        killAllProjectJobs();
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
