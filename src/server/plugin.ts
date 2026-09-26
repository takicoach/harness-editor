import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { HttpError, sendApiError, sendJson, sendText } from './http';
import { getProjectRoot, resolveProjectDir, resolvePublicAsset } from './projectRoot';
import { isSuperMovieProject, scanProjects } from './scanProjects';
import { sweepCaptureTmpDirs } from './captureTmpSweep';
import { parseVideoConfigStatic } from '../core';
import { loadProjectFromDir } from './loadProjectFiles';
import { isUploadKind, materialRelPath, sanitizeUploadName, saveMaterialFile } from './uploadMaterial';
import { scanMaterialUsage } from './materialUsage';
import { findBusyJobs } from './projectBusy';
import { PROJECT_JOB_MANAGERS, killAllProjectJobs } from './jobRegistries';
import { emptyTrash, listTrash, moveToTrash, restoreFromTrash } from './trashStore';
import { makeAssetKey, type AssetKind } from '../shared/assetKey';
import { precheckCreateImages, precheckCreateProject, precheckProjectName } from './projectCreationChecks';
import { createSequenceImageProject, createSequenceProject } from './sequence/create';
import { receiveImageUploads } from './sequence/imageUpload';
import { IMAGE_UPLOAD_MANIFEST_MAX_BYTES } from '../shared/imageUploadFrame';
import { MAX_CREATE_IMAGE_BYTES, MAX_CREATE_IMAGES } from '../shared/createMedia';
import { assertBrowsablePath, browseRoots, listDirectory,BROWSE_MEDIA_EXTENSIONS } from './browsePaths';
import {
  assertSourceAvailable,
  assertVideoProcessingAllowed,
  projectVideoFile,
} from './videoLink';
import { relinkVideo } from './relinkVideo';
import { convertProjectToLink, describeLinkMissReason, findConvertCandidate } from './convertToLink';
import { streamBodyToTempFile, assertContentLengthWithin, resolveMaxUploadBytes } from './streamUpload';
import { readJsonBody, readBodyText } from './readBody';
import {expectedReferenceFingerprint} from './sequence/references';
import { handlePreferenceApi } from './preferenceApi';
import { EditorAgentContext } from './editorAgentContext';
import { EditorOperationStore } from './editorOperationStore';
import { EditorAgentService } from './editorAgentService';
import { handleEditorAgentApi, sendEditorAgentError } from './editorAgentApi';
import { assertEditorDeliveryMaySave } from './editorSaveGuard';
import { saveProjectToDir, validateSaveRequest } from './saveProject';
import { serveVideo } from './serveVideo';
import { resolveTrashVideoPath } from './trashVideo';
import { previewProxyName, resolveVideoPathForVersion } from './previewProxy';
import { serveAsset } from './serveAsset';
import { bundleNativeTelopComponent } from './bundleTelop';
import { compileSequenceComponent } from './sequence/components';
import { isAllowedLocalRequest } from './localGuard';
import { convertBurnedInProject } from './convertProject';
import { installTelopPack } from './installTelopPack';
import { inspectTelopFolder, telopAdd } from './telopAdd';
import { applyTelopTemplateUpdate, assertTelopTemplatePlanId, planTelopTemplateUpdate, readTelopTemplateUpdateStatus, revertTelopTemplateUpdate } from './telopTemplateUpdate';
import { applyTelopPackUpdate, planTelopPackUpdate } from './telopPackUpdate';
import { sequenceService } from './sequence/service';
import { installVideoInsert } from './installVideoInsert';
import { installBgm } from './installBgm';
import { installShape } from './installShape';
import { installTransition } from './installTransition';
import { installSpeed } from './installSpeed';
import { installMainLayout } from './installMainLayout';
import { installImageRendering } from './installImageRendering';
import { checkStalePacks, findDescriptor, latestPackBackupVersion, packUpgradeNotices, restorePackComponents, upgradePacks } from './packUpgrade';
import { collectScriptAlignmentArtifact, collectScriptEditInput, type ScriptAlignmentMode } from './scriptAlignmentApi';
import { assertScriptEditArtifactCurrent, parseScriptEditArtifact } from './scriptEditArtifacts';
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
import { handleAudioFixPost, handleAudioFixStatus } from './audioFixApi';
import {
  handleRenderPost,
  handleRenderSse,
  handleRenderDelete,
  handleRenderReveal,
  restoreRenderJobs,
  reconcileRenderJobs,
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
  approveLearning,
  handleLearningDiff,
  handleLearningStatus,
  validateApproveRequest,
} from './learningApi';
import { computeNativeLearningDiff, hasNativeDocument } from './learning/nativeLearningDiff';
import { runLearningApprove } from './learning/approveQueue';
import { instructionInbox, isAgentConnected, validateInstructionInput } from './instructionInbox';
import { wireInboxPersistence } from './inboxServerLifecycle';
import { validateStatusRequest, writeStatusStage } from './projectStatus';
import { handleMcpRequest } from './mcp/server';
import { markSelfWrite, isSelfWriting, isSelfWriteContent, recordSelfWriteContent, selfWriteRemainingMs, clearSelfWrite } from './selfWrite';
import { projectContentSignature } from './projectWatchPaths';
import { handleEventsSse, handleEventsSync,restoreRenderObservations } from './eventsApi';
import { handleCaptureEngineStatus } from './captureEngineApi';
import { bundleCaptureEntry, bundleCaptureRuntime } from './bundleCapture';
import { buildCapturePageHtml } from '../capturePage/html';
import { setServerOrigin, wireServerOrigin } from './serverOrigin';
import { applyKeepAliveTimeouts } from './keepAlive';
import { installProcessSafetyNet } from './processSafetyNet';
import { handleSequenceApi } from './sequence/api';
import { handleLegacyPreviewApi } from './sequence/legacyPreviewApi';
import { assertLegacySequenceAuthority } from './sequence/authority';
import { hasSequenceDocument } from './sequence/summary';
import { SequenceStore } from './sequence/store';
import { sequenceEditorTargets } from '../core/sequence/editorCommands';
import {createNativeEditorAgentAdapter} from './nativeEditorAgentAdapter';

/** URL から必須クエリパラメータを取り出す。無ければ HttpError。 */
export function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    throw new HttpError(400, `クエリパラメータ "${name}" が必要です`);
  }
  return value;
}

/** 案件の編集データに既に入っているテロップスタイル番号（下見と本番で同じ基準を使う）。 */
function existingTelopStyleIds(projectDir: string): number[] {
  const session = new SequenceStore(projectDir).load();
  return (session?.document.assets ?? []).flatMap(asset => asset.textStyleCatalog?.entries.map(entry => entry.id) ?? []);
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

/**
 * 保存リクエストの `X-Harness-Writer` ヘッダ（画面ごとの識別子）を読む。
 * 未送信・空・配列（重複ヘッダ）は undefined＝従来どおり projectId 単位の扱いにする。
 */
export function readWriterId(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-harness-writer'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** /api/* のリクエストを処理する（ルート単位のテストのため export）。 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
  editor?: EditorAgentService,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (await handleLegacyPreviewApi(req, res, url, root)) return;
  if (await handleSequenceApi(req, res, url, root, undefined, editor)) return;

  if (url.pathname === '/api/ping') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/projects') {
    sendJson(res, 200, { root: root, projects: scanProjects(root) });
    return;
  }
  if (url.pathname === '/api/script-alignment' || url.pathname === '/api/script-edit-input' || url.pathname === '/api/script-edit-review') {
    const review = url.pathname === '/api/script-edit-review';
    if (method !== (review ? 'POST' : 'GET')) throw new HttpError(405, review ? 'このエンドポイントは POST のみ対応します' : 'このエンドポイントは GET のみ対応します');
    const id = requireParam(url, 'id');
    const mode = url.searchParams.get('mode');
    if (mode !== 'caption' && mode !== 'structure') {
      throw new HttpError(400, 'mode は caption または structure を指定してください');
    }
    const expectedPreviewVersion = url.searchParams.get('expectedPreviewVersion') ?? undefined;
    if (expectedPreviewVersion !== undefined && !/^\d+-\d+$/.test(expectedPreviewVersion)) {
      throw new HttpError(400, 'expectedPreviewVersion が不正です');
    }
    const dir = resolveProjectDir(root, id);
    if (!existsSync(dir) || !isSuperMovieProject(dir)) {
      throw new HttpError(404, `プロジェクトが見つかりません: ${id}`);
    }
    if(hasSequenceDocument(dir)) throw new HttpError(409,'NATIVE_SCRIPT_REVIEW_REQUIRED: 台本案の新形式への接続は準備中です');
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    const abortIfResponseClosed = (): void => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abortIfResponseClosed);
    try {
      // A review request validates an uploaded draft; it never persists or enqueues an edit.
      let draft;
      if (review) {
        const body = await readJsonBody(req);
        try { draft = parseScriptEditArtifact(body); }
        catch { throw new HttpError(400, '変更案の内容を確認できません。スキルで作成した変更案を選んでください。'); }
        if (draft.input.alignment.packet.projectId !== id || draft.proposal.kind !== mode) {
          throw new HttpError(409, 'この案件・目的に対応する変更案を選んでください。');
        }
      }
      const collect = url.pathname !== '/api/script-alignment' ? collectScriptEditInput : collectScriptAlignmentArtifact;
      const artifact = await collect(id, dir, {
        mode: mode as ScriptAlignmentMode,
        ...(expectedPreviewVersion === undefined ? {} : { expectedPreviewVersion }),
        signal: controller.signal,
      });
      if (draft) {
        try { assertScriptEditArtifactCurrent(draft, artifact); }
        catch { throw new HttpError(409, '台本・発話・編集内容が変更案の作成時から変わっています。現在の内容から案を作り直してください。'); }
      }
      sendJson(res, 200, draft ?? artifact);
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfResponseClosed);
    }
    return;
  }
  if (url.pathname === '/api/project') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'PUT') {
      assertLegacySequenceAuthority(dir);
      const body = await readJsonBody(req);
      const saveReq = validateSaveRequest(body);
      assertEditorDeliveryMaySave(req.headers, id, editor);
      // 書き込みが走る前にウィンドウをマークし、chokidar の change を suppress する。
      // X-Harness-Writer があれば「どの画面が書いたか」まで記録し、別画面には
      // 外部変更として通知されるようにする（data-safety-5）。ヘッダ無しは従来動作。
      markSelfWrite(id, readWriterId(req));
      const saved = saveProjectToDir(dir, saveReq);
      // 書き終えた姿を記録する。watch の再評価がこれと突き合わせて「自分の保存の残響」を
      // 外部変更として通知しないようにする（サイクル 2 レビュー Important）。
      recordSelfWriteContent(id, projectContentSignature(dir));
      sendJson(res, 200, saved);
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
      if (!isSuperMovieProject(dir)) {
        throw new HttpError(400, `対応する動画プロジェクトではありません: ${id}`);
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
      }, dir);
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
    if (!statSync(dir).isDirectory() || !isSuperMovieProject(dir)) {
      throw new HttpError(400, `対応する動画プロジェクトではありません: ${id}`);
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
    if (!existsSync(dir) || !isSuperMovieProject(dir)) {
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
    const busy = findBusyJobs(id, PROJECT_JOB_MANAGERS, dir);
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
    sendJson(res, 200, listDirectory(real, roots,url.searchParams.get('media')==='all'?{extensions:BROWSE_MEDIA_EXTENSIONS}:{}));
    return;
  }
  if (url.pathname === '/api/create-project-link') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    if (url.searchParams.get('native') !== '1') {
      throw new HttpError(410, '旧形式での新規作成は終了しました。独自編集画面から作成してください。');
    }
    const name = requireParam(url, 'name');
    const target = assertBrowsablePath(requireParam(url, 'path'), browseRoots());
    const text=await readBodyText(req,4096);let expectedFingerprint:string|undefined;
    if(text){let value:unknown;try{value=JSON.parse(text);}catch{throw new HttpError(400,'素材参照のJSONが不正です');}
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='expectedFingerprint'))throw new HttpError(400,'素材参照の指定が不正です');
      expectedFingerprint=expectedReferenceFingerprint((value as {expectedFingerprint?:unknown}).expectedFingerprint);
    }
    precheckCreateProject(root, name, target);
    const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)abort();};req.once('aborted',abort);res.once('close',closed);
    if(req.aborted||res.destroyed)controller.abort();
    let result:{id:string};try{result=await createSequenceProject(root, { name, videoName: target, sourcePath: target, reference:true,expectedFingerprint },controller.signal);}
    finally{req.off('aborted',abort);res.off('close',closed);}
    sendJson(res, 200, result);
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
    if (url.searchParams.get('native') !== '1') {
      throw new HttpError(410, '旧形式での新規作成は終了しました。独自編集画面から作成してください。');
    }
    const name = requireParam(url, 'name');
    const videoName = requireParam(url, 'video');
    // 数GBを受け切ってから弾く無駄を避けるため、名前・拡張子・重複は受信前にチェックする。
    precheckCreateProject(root, name, videoName);
    // ボディはメモリに載せず一時ファイルへ直接書く。上限は HARNESS_MAX_UPLOAD_BYTES（既定32GiB）で
    // ディスク枯渇 DoS を防ぐ。Content-Length があれば受信前に弾く。
    const maxUpload = resolveMaxUploadBytes();
    assertContentLengthWithin(req, maxUpload);
    // Native import owns its managed copy; always remove the upload temporary file.
    const tmpPath = await streamBodyToTempFile(req, uploadTmpDir(root), maxUpload);
    try {
      const result = await createSequenceProject(root, { name, videoName, sourcePath: tmpPath });
      sendJson(res, 200, { ...result, projects: scanProjects(root) });
    } finally {
      rmSync(tmpPath, { force: true });
    }
    return;
  }
  if (url.pathname === '/api/create-project-images' || url.pathname === '/api/create-project-image-paths') {
    // 複数の画像から1つの作品を作る（設計 M3b）。画像はいつもコピーで取り込み、全件を検査してから1回で確定する。
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    if (url.searchParams.get('native') !== '1') {
      throw new HttpError(410, '旧形式での新規作成は終了しました。独自編集画面から作成してください。');
    }
    const name = requireParam(url, 'name');
    precheckProjectName(root, name);
    const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)abort();};req.once('aborted',abort);res.once('close',closed);
    if(req.aborted||res.destroyed)controller.abort();
    const staging = join(uploadTmpDir(root), `images-${randomUUID()}`);
    try {
      let images: Array<{ name: string; sourcePath: string }>;
      if (url.pathname === '/api/create-project-images') {
        assertContentLengthWithin(req, MAX_CREATE_IMAGE_BYTES + IMAGE_UPLOAD_MANIFEST_MAX_BYTES + 4);
        mkdirSync(staging, { recursive: true });
        images = (await receiveImageUploads(req, staging)).map(image => ({ name: image.name, sourcePath: image.path }));
      } else {
        let value: unknown;
        try { value = JSON.parse(await readBodyText(req, 256 * 1024)); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, '画像の一覧のJSONが不正です'); }
        const paths = (value as { paths?: unknown })?.paths;
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_CREATE_IMAGES || paths.some(path => typeof path !== 'string')
          || Object.keys(value as object).some(key => key !== 'paths')) throw new HttpError(400, `画像を1〜${MAX_CREATE_IMAGES}枚選んでください`);
        const roots = browseRoots();
        images = (paths as string[]).map(path => { const target = assertBrowsablePath(path, roots); return { name: basename(target), sourcePath: target }; });
      }
      precheckCreateImages(root, name, images.map(image => image.name));
      const result = await createSequenceImageProject(root, { name, images }, controller.signal);
      sendJson(res, 200, { ...result, projects: scanProjects(root) });
    } finally {
      req.off('aborted',abort);res.off('close',closed);
      // この要求が作った一時フォルダだけを消す（成功・失敗・中止・切断のどれでも）。
      rmSync(staging, { recursive: true, force: true });
    }
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
  if (url.pathname === '/api/capture-component') {
    if (method !== 'GET') throw new HttpError(405, '撮影用部品は GET のみ対応します');
    const kind = requireParam(url, 'kind');
    if (kind !== 'telop' && kind !== 'image') throw new HttpError(400, '撮影用部品の種類が不正です');
    const dir = resolveProjectDir(root, requireParam(url, 'id'));
    // No swatch staticFile base: the capture page supplies its project resolver.
    const bytes = await compileSequenceComponent(dir,
      kind === 'telop' ? 'src/テロップテンプレート/Telop.tsx' : 'src/InsertImage/InsertImage.tsx',
      kind === 'telop' ? 'Telop' : 'InsertImage').catch((error: unknown) => {
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll('旧部品を変更せず移行を中止しました', '元の部品を変更せず撮影の準備を中止しました')
        .replaceAll('移行できません', '撮影では利用できません');
      throw new Error(`撮影用の${kind === 'telop' ? '字幕' : '画像'}部品を準備できませんでした。\n${detail}`);
    });
    sendText(res, 200, new TextDecoder().decode(bytes), 'text/javascript; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/native-telop-component') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const js = await bundleNativeTelopComponent(dir, id);
    sendText(res, 200, js, 'text/javascript; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/convert-burned-in') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    const result = convertBurnedInProject(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-telop-pack') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installTelopPack(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  // 設計 D の第 1 段（下見）。inspectTelopFolder しか呼ばないので案件には一切書き込まない。
  // UI はこの結果で確認画面を出し、「一覧に加える」を押したときだけ下の本番ルートを叩く。
  // （I-1: 以前は本番ルートが取り込みまで済ませてから確認を出しており、「やめる」で残骸が残った。）
  if (url.pathname === '/api/telop-add/inspect') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const body = (await readJsonBody(req, 1024 * 64)) as { dir?: unknown };
    if (typeof body.dir !== 'string' || !body.dir) {
      throw new HttpError(400, '取り込むフォルダを指定してください');
    }
    const source = assertBrowsablePath(body.dir, browseRoots());
    const report = inspectTelopFolder(source);
    const existing = existingTelopStyleIds(dir);
    sendJson(res, 200, { packId: report.packId, version: report.version, kind: report.kind,
      ids: report.ids, names: report.names, conflicts: report.ids.filter(styleId => existing.includes(styleId)) });
    return;
  }
  if (url.pathname === '/api/telop-add') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const body = (await readJsonBody(req, 1024 * 64)) as { dir?: unknown };
    if (typeof body.dir !== 'string' || !body.dir) {
      throw new HttpError(400, '取り込むフォルダを指定してください');
    }
    // 走査できるのはサーバが許可した起点の配下だけ（/api/browse と同じ封じ込め）。
    const source = assertBrowsablePath(body.dir, browseRoots());
    const existing = existingTelopStyleIds(dir);
    markSelfWrite(id);
    const result = await telopAdd(dir, source, existing);
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, { packId: result.packId, version: result.version, kind: result.kind, added: result.added, conflicts: result.conflicts, asset: result.asset });
    return;
  }
  if (url.pathname === '/api/telop-template-update/status') {
    if (method !== 'GET') throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 読み取り専用。字幕設定のアンマウントで画面側の `applied` state が消えたときの復元用（Codex P2）。
    sendJson(res, 200, { applied: readTelopTemplateUpdateStatus(dir) });
    return;
  }
  // 同梱テロップパックの 3 段導線（native 案件の凍結部品向け。案件テンプレートを書き換える
  // /api/telop-template-update とは別経路で、409 reason:'telop-pack' はそのまま残す）。
  if (url.pathname === '/api/telop-pack-update/plan') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 読み取り専用。plan は案件に 1 バイトも書かない（事前検査 B の F9-2）。
    const session = sequenceService.open(dir);
    // `{plan, reason?}` をそのまま返す。reason は計画が出せない**理由**（画面の文言分岐。Codex 2 巡目 #4）。
    sendJson(res, 200, planTelopPackUpdate(dir, session.document));
    return;
  }
  if (url.pathname === '/api/telop-pack-update/apply') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // .harness/components/ へ新しい部品を凍結するだけ。文書への登録と参照切替は画面側の 2 コマンド。
    markSelfWrite(id);
    const asset = await applyTelopPackUpdate(dir);
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, { asset });
    return;
  }
  if (url.pathname === '/api/telop-template-update/plan') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 文書はセッションの現物を使う（保存済みファイルではなく、画面が見ている revision）。
    const session = sequenceService.open(dir);
    const plan = await planTelopTemplateUpdate(dir, session.document);
    sendJson(res, 200, plan);
    return;
  }
  if (url.pathname === '/api/telop-template-update/apply') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const body = (await readJsonBody(req, 1024 * 64)) as { planId?: unknown; expectedRevision?: unknown };
    if (typeof body.planId !== 'string' || !body.planId) throw new HttpError(400, '確認の結果を指定してください');
    assertTelopTemplatePlanId(body.planId);
    if (!Number.isSafeInteger(body.expectedRevision)) throw new HttpError(400, '編集の版が不正です');
    const session = sequenceService.open(dir);
    markSelfWrite(id);
    const result = await applyTelopTemplateUpdate(dir, session.document,
      { planId: body.planId, expectedRevision: body.expectedRevision as number });
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/telop-template-update/revert') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const body = (await readJsonBody(req, 1024 * 64)) as { planId?: unknown };
    if (typeof body.planId !== 'string' || !body.planId) throw new HttpError(400, '確認の結果を指定してください');
    assertTelopTemplatePlanId(body.planId);
    const session = sequenceService.open(dir);
    markSelfWrite(id);
    const result = await revertTelopTemplateUpdate(dir, body.planId, session.document);
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-video-insert') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installVideoInsert(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-bgm') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installBgm(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-shape') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installShape(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-transition') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installTransition(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-speed') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installSpeed(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-main-layout') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 導入はデータファイル（shapeData.ts 等）を配置する＝監視対象の書き換え。
    // マークしないと自分の導入で外部変更バナーが誤発火する（data-safety-9）。
    markSelfWrite(id);
    const result = installMainLayout(dir);
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/install-image-rendering') {
    if (method !== 'POST') throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (findBusyJobs(id, PROJECT_JOB_MANAGERS, dir).length || instructionInbox.hasProcessing(id)) {
      throw new HttpError(409, 'この案件の処理が終わってから画像表示を更新してください。');
    }
    markSelfWrite(id);
    const result = installImageRendering(dir);
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/capture-engine/status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    sendJson(res, 200, handleCaptureEngineStatus());
    return;
  }
  if (url.pathname === '/api/pack-status') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    const stale = checkStalePacks(dir);
    // 更新の前に「何が変わるか」を出すための材料。字幕数は**保存済みの文書から数えられるときだけ**返し、
    // 数えられなければ null（推定しない）。
    // `revertable` は**控えの有無**。これが無いと画面は「戻す」を stale ブロックの中にしか置けず、
    // 更新が成功した瞬間に stale が空になってボタンごと消える（事前検査 B の B10-2）。
    sendJson(res, 200, {
      stale,
      notices: packUpgradeNotices(dir, stale),
      revertable: latestPackBackupVersion(findDescriptor('telopPack'), dir) !== null,
    });
    return;
  }
  if (url.pathname === '/api/pack-revert') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    try {
      const result = restorePackComponents(findDescriptor('telopPack'), dir);
      // 書き終えた姿を記録する（/api/pack-upgrade と同じ 3 手順）。
      recordSelfWriteContent(id, projectContentSignature(dir));
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof Error && error.message === 'backup-missing') {
        throw new HttpError(404, '更新前の控えがありません。', { reason: 'backup-missing' });
      }
      throw error;
    }
    return;
  }
  if (url.pathname === '/api/pack-upgrade') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    const result = upgradePacks(dir, checkStalePacks(dir));
    // 書き終えた姿を記録する。これが無いと窓明けの再評価で自分の導入を
    // 外部変更と誤判定してバナーが出る（PUT と同じ 3 手順に揃える）。
    recordSelfWriteContent(id, projectContentSignature(dir));
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/events') {
    // GET /api/events(?id=<projectId>) — SSE 1 本統合エンドポイント。
    // id 無し = ホーム画面用（projects チャネルのみ）。id 有り = エディタ画面用（全チャネル）。
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = url.searchParams.get('id');
    // ?w=<writerId>: この画面の識別子。自分の保存だけを suppress するために使う（data-safety-5）。
    const writer = url.searchParams.get('w');
    handleEventsSse(
      req,
      res,
      root,
      id !== null && id !== '' ? id : null,
      writer !== null && writer !== '' ? writer : undefined,
      id?()=>restoreRenderObservations(root,id):undefined,
    );
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
    sendJson(res, 200, ch==='render'?{messages:await restoreRenderObservations(root,id)}:handleEventsSync(id, ch));
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
  // 新形式（native）の音声補正。原本を書き換えず、別の不変 asset を登録して返す。
  // 旧形式の /api/denoise*・/api/normalize*（public/main.mp4 を差し替える）とは別系統。
  if (url.pathname === '/api/audio-fix') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    markSelfWrite(id);
    await handleAudioFixPost(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/audio-fix/status') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    handleAudioFixStatus(req, res, requireParam(url, 'id'));
    return;
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
    await restoreRenderJobs(id,dir);
    handleRenderReveal(req, res, id, dir);
    return;
  }
  if (url.pathname === '/api/render') {
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    if (method === 'POST') {
      assertLegacySequenceAuthority(dir);
      // 外付け未接続のまま数時間かけて失敗するのを防ぐ（開始前に弾く）。
      assertSourceAvailable(dir);
      await handleRenderPost(
        req,
        res,
        id,
        dir,
        url.searchParams.get('force') === '1',
        url.searchParams.get('mockWarning') === '1',
      );
      return;
    }
    if (method === 'GET') {
      await restoreRenderJobs(id,dir);
      handleRenderSse(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      reconcileRenderJobs(id,dir);
      handleRenderDelete(req, res, id);
      return;
    }
    throw new HttpError(405, `${method} は対応していません`);
  }
  if (url.pathname === '/api/preferences' || url.pathname.startsWith('/api/preferences/')) {
    await handlePreferenceApi(req, res, url, root);
    return;
  }
  if (url.pathname === '/api/learning/diff') {
    if (method !== 'GET') {
      throw new HttpError(405, 'このエンドポイントは GET のみ対応します');
    }
    const id = requireParam(url, 'id');
    const dir = resolveProjectDir(root, id);
    // 新形式の案件は「完了した書き出しジョブ」と結び付けて差分を出す（job 必須）。旧形式は従来どおり。
    if (hasNativeDocument(dir)) {
      const job = requireParam(url, 'job');
      sendJson(res, 200, (await computeNativeLearningDiff(dir, job)).response);
      return;
    }
    sendJson(res, 200, handleLearningDiff(dir));
    return;
  }
  if (url.pathname === '/api/learning/approve') {
    if (method !== 'POST') {
      throw new HttpError(405, 'このエンドポイントは POST のみ対応します');
    }
    // 旧来の差分承認（jsonl 追記＋*_rules.json の自動昇格）。「編集の好み」とは別の仕組みとして並ぶ（設計書 D1）。
    // 承認は処理待ちの列で1件ずつ実行する（D12）。
    const body = validateApproveRequest(await readJsonBody(req));
    const dir = resolveProjectDir(root, body.projectId);
    sendJson(res, 200, await runLearningApprove(() => approveLearning(dir, body)));
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
        requestId: input.requestId,
        requestCreatedAt: input.requestCreatedAt,
        projectId: input.projectId,
        projectDir: dir,
        text: input.text,
        context: input.context,
      });
    } catch (err) {
      // 永続化書き込み失敗（ディスク容量不足等）。「受付成功」と偽らず 500 を返す。
      if (err instanceof HttpError) throw err;
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
        {
          isSelfWrite: () => isSelfWriting(id),
          selfWriteRemainingMs: () => selfWriteRemainingMs(id),
          isSelfContent: () => isSelfWriteContent(id, undefined, projectContentSignature(dir)),
        },
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

// ---------------------------------------------------------------------------
// 撮影ページ（M2b・オーバーレイのフレーム撮影用の面）
// ---------------------------------------------------------------------------

/** 撮影ページが使う route（プレビュー本体 index.html とは別の面）。 */
const CAPTURE_ROUTES = new Set(['/capture', '/capture/runtime.js', '/capture/entry.js']);

/** このパスを撮影ページ route が引き受けるか。 */
export function isCaptureRoute(pathname: string): boolean {
  return CAPTURE_ROUTES.has(pathname);
}

/**
 * 撮影ページ route のハンドラ（M2b T2）。HTML と2本のブラウザバンドルを返すだけの
 * 読み取り専用 route で、プレビュー本体・製品の書き出し経路には一切触れない。
 */
export async function handleCaptureRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    throw new HttpError(405, '撮影ページは GET のみ対応します');
  }
  if (url.pathname === '/capture') {
    sendText(res, 200, buildCapturePageHtml(), 'text/html; charset=utf-8');
    return;
  }
  if (url.pathname === '/capture/runtime.js') {
    sendText(res, 200, await bundleCaptureRuntime(), 'text/javascript; charset=utf-8');
    return;
  }
  if (url.pathname === '/capture/entry.js') {
    sendText(res, 200, await bundleCaptureEntry(), 'text/javascript; charset=utf-8');
    return;
  }
  throw new HttpError(404, `撮影 route が見つかりません: ${url.pathname}`);
}

/** Harness Editor のローカルサーバを Vite 開発サーバへ組み込む Vite プラグイン。 */
export function smeServer(): Plugin {
  return {
    name: 'sme-server',
    // configureServer 内で直接 use するとミドルウェアは Vite 内部処理より先に走る。
    configureServer(server) {
      // X-1 最後の砦: この dev サーバー自体が製品のプロセス。個別の握り潰し
      // （ptySession.ts の resize/write 保護など）で塞ぎきれない未知の経路が
      // 残っていても、uncaughtException/unhandledRejection でプロセスごと
      // 落として白画面・未保存編集消失を起こさない。詳細は processSafetyNet.ts。
      installProcessSafetyNet();
      const root = getProjectRoot();
      let editorReady = false;
      const editorOperations = new EditorOperationStore(join(root, '.sme-editor-operations.json'), randomUUID());
      const editor = new EditorAgentService(editorOperations, (id) => {
        const directory = resolveProjectDir(root, id);
        if (!existsSync(directory) || !isSuperMovieProject(directory)) throw new HttpError(404, 'PROJECT_NOT_FOUND: 案件が見つかりません');
      }, Date.now, 15000, (id) => {
        const directory=resolveProjectDir(root,id);
        if(hasSequenceDocument(directory)) {
          const saved=new SequenceStore(directory).load();
          if(!saved) throw new Error('SAVED_STATE_MISSING: 保存内容がありません');
          return {elements:sequenceEditorTargets(saved.document),fingerprint:`${saved.savedRevision}:${saved.contentHash}`};
        }
        const loaded = loadProjectFromDir(directory);
        return { elements: loaded.project.telops.map((telop) => ({ id: String(telop.id), text: telop.text,
          sourceFrameRange: { start: telop.originalStart, end: telop.originalEnd } })), fingerprint: JSON.stringify(loaded.save.fingerprint) };
      }, new EditorAgentContext(root),createNativeEditorAgentAdapter(root));
      console.log(`[sme] プロジェクトルート: ${root}`);
      // Viteは旧サーバのcloseより先に新configureを呼ぶ。listen時に永続化を取得する。
      wireInboxPersistence(server.httpServer ?? null, instructionInbox, join(root, '.sme-inbox.json'), {
        resolveProjectDir: (projectId) => {
          try {
            return resolveProjectDir(root, projectId);
          } catch {
            return null;
          }
        },
      }, (persisted) => {
        if (persisted) {
          try { editorOperations.recoverInterrupted(); editorReady = true; }
          catch (error) { console.error('[sme] AI編集の実行記録を復元できません:', error); }
        }
        if (!persisted) console.warn('[sme] 受け箱の永続化を無効化しました（同じフォルダで別のエディタが起動中です）');
        // 旧サーバの終了と所有権取得後にだけ残骸を掃除する。別サーバの処理中素材を消さない。
        if (persisted) rmSync(uploadTmpDir(root), { recursive: true, force: true });
        sweepCaptureTmpDirs(root, { guard: persisted });
      });
      // 実 origin の記録（設計判断7）: Host ヘッダ推測はせず、実際に listen したアドレスから
      // 組み立てる。撮影ドライバ（captureDriver）へ渡す serverUrl の正本になる（実配線は T5）。
      // 配線本体は serverOrigin.ts の wireServerOrigin() に切り出してある（フック注入で
      // pin できるようにするため・serverOrigin.test.ts 参照）。
      wireServerOrigin(server.httpServer ?? null);
      // アイドル接続をサーバ側から 5 秒で切らない（Node 既定のままだと、接続を使い回した
      // クライアントが ECONNRESET を食う。保存 POST は再送されないので実害がある）。
      applyKeepAliveTimeouts(server.httpServer);
      // Vite サーバ停止時に進行中の subprocess を全 kill する。
      server.httpServer?.on('close', () => {
        editorReady = false;
        try { for (const session of editor.sessions.list()) editorOperations.disconnect(session.sessionId); }
        catch (error) { console.error('[sme] AI編集の終了記録を確認できません:', error); }
        killAllProjectJobs();
        setServerOrigin(null);
      });
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');
        // このミドルウェアは Vite 内部の Host チェックより先に走るため、
        // DNS リバインディング/CSRF 対策として /api・/mcp は自前でローカル起源を検証する。
        if (url.pathname === '/mcp' || rawUrl.startsWith('/api/') || isCaptureRoute(url.pathname)) {
          if (!isAllowedLocalRequest(req.headers)) {
            if (url.pathname === '/mcp' || url.pathname.startsWith('/api/editor/')) {
              sendEditorAgentError(res, new HttpError(403, 'ローカル以外からのアクセスは許可されていません'),
                {}, 'LOCAL_REQUEST_REQUIRED');
            } else sendJson(res, 403, { error: 'ローカル以外からのアクセスは許可されていません' });
            return;
          }
        }
        // 撮影ページ（M2b）。プレビュー本体とは別の面を配信するだけの読み取り専用 route。
        if (isCaptureRoute(url.pathname)) {
          handleCaptureRoute(req, res, url).catch((err: unknown) => {
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof Error ? err.message : String(err);
            if (status >= 500) console.error('[sme] 撮影 route エラー:', err);
            sendJson(res, status, { error: message });
          });
          return;
        }
        if (url.pathname === '/mcp') {
          // POST のみ本文を読む。GET(SSE)/DELETE は本文なし。
          const method = (req.method ?? 'GET').toUpperCase();
          const run = async (): Promise<void> => {
            const body = method === 'POST' ? await readJsonBody(req) : undefined;
            await handleMcpRequest(req, res, instructionInbox, body, editorReady ? editor : undefined);
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
        const editorRoute = url.pathname.startsWith('/api/editor/');
        if (editorRoute && !editorReady) {
          sendEditorAgentError(res, new HttpError(503, 'EDITOR_SERVICE_UNAVAILABLE: AI編集の実行記録を確認できません'));
          return;
        }
        const api = editorRoute
          ? handleEditorAgentApi(req, res, url, editor)
          : handleApi(req, res, url, root, editorReady ? editor : undefined);
        api.catch((err: unknown) => {
          if (editorRoute) { sendEditorAgentError(res, err); return; }
          if (!(err instanceof HttpError) || err.status >= 500) console.error('[sme] APIエラー:', err);
          sendApiError(res, err);
        });
      });
    },
  };
}
