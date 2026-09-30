import {nativeProxyPath,nativeProxyStatus,startNativeProxy} from './previewProxy';
import type {SequenceDocument} from '../../core/sequence/model';
import {applyExternalEdit,listExternalEdits} from './externalEdits';
import {LegacyCutBackfills} from './legacyCutBackfill';
import {validateResizeCutBoundaryCommand} from '../../core/sequence/cutBoundary';
import {validateAdoptSourceGap} from '../../core/sequence/adoptSourceGap';
import {isNativeSpeedCommandType,validateNativeSpeedCommand} from '../../core/sequence/speedCommandValidation';
import {MAX_SEQUENCE_COMMAND_LEAVES,SEQUENCE_COMMAND_TYPES,SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP,SEQUENCE_HISTORY_COMMAND_TYPES} from '../../core/sequence/commandTypes';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpError, sendJson, sendText } from '../http';
import { resolveProjectDir } from '../projectRoot';
import { readJsonBody } from '../readBody';
import { serveAsset } from '../serveAsset';
import {serveSequenceAsset} from './serveAsset';
import {assertBrowsablePath,browseRoots} from '../browsePaths';
import {registerSequenceReference,reconnectSequenceReference,sequenceReferenceStatus,expectedReferenceFingerprint} from './references';
import {matchSequenceReference} from './referenceMatch';
import { SequenceError } from '../../core/sequence/errors';
import type { EditRequest } from '../../core/sequence/session';
import { rational } from '../../core/sequence/time';
import {validateSceneFadeEdit} from '../../core/sequence/sceneFadeEdits';
import { SequenceStore } from './store';
import {preflightSequenceExport} from './exportPreflight';
import {exportRequestSchema} from './exportRecords';
import {validateRestoreCutCommand} from '../../core/sequence/cutArchive';
import { sequenceService as service } from './service';
import { legacyInputFingerprint, migrateSequenceProject } from './migration';
import { readSequenceComponent } from './components';
import {prepareNativeTextStyleAssets,textStyleAssetsToRegister} from './textStyles';
import type { SequenceAsset } from '../../core/sequence/model';
import { importSequenceAsset, registerAssetOrigin, registeredSequenceAssets, verifiedSequenceAssetPath } from './assets';
import { prepareSequenceAudio } from './media';
import {prepareSequenceWaveform,waveformRequestFromQuery} from './waveform';
import { sequenceExports as exports } from './exports';
import {exportSettingsSchema} from './exportRecords';
import { assertContentLengthWithin, resolveMaxUploadBytes, streamBodyToTempFile } from '../streamUpload';
import { assertEditorDeliveryMayApply, assertEditorDeliveryMaySave } from '../editorSaveGuard';
import type { EditorAgentService } from '../editorAgentService';
import { editorChangeSetSchema } from '../../shared/editorCommands';
import { sequenceEditorRevision } from '../../core/sequence/editorCommands';
import { collectSequenceScriptAlignment } from './script';
import { collectNativeScriptEditInput,assertNativeScriptEditCurrent } from './scriptEdits';
import { scriptEditModificationSchema,resolveScriptEditPlan } from '../../core/scriptEditModification';
import { sequenceTranscriptions } from './transcriptions';
import { heavyJobCounts,heavyJobGate } from '../systemLoad';

const legacyBackfillsByService=new WeakMap<object,LegacyCutBackfills>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '要求の形式が不正です');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new HttpError(400, '要求のIDが不正です');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(400, '要求の番号が不正です');
  return value as number;
}
/** Keep the saved movie recognizable while avoiding separators and control characters in a filename. */
export function nativeExportContentDisposition(projectName:string):string {
  const safe=projectName.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,80)||'動画';
  return `attachment; filename="harness.mp4"; filename*=UTF-8''${encodeURIComponent(`ハーネス_${safe}.mp4`)}`;
}
/**
 * /command が受け付ける操作は SequenceCommand の union から導出する（手書きの列挙をやめる）。
 * 専用ルートだけが発行するものは SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP に理由つきで並べ、
 * 「union − 拒否リスト ＋ 履歴操作 = 受理集合」をテストで固定する（commandAllowList.test.ts）。
 */
export const SEQUENCE_API_COMMAND_TYPES: readonly string[] = [
  ...SEQUENCE_COMMAND_TYPES.filter(type => !(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP as readonly string[]).includes(type)),
  ...SEQUENCE_HISTORY_COMMAND_TYPES,
];
function editRequest(body: Record<string, unknown>, depth = 0, budget = {leafCount: 0}): EditRequest {
  const command = object(body.command), type = command.type;
  if (typeof type!=='string'||!SEQUENCE_API_COMMAND_TYPES.includes(type)) throw new HttpError(400, '未対応の編集操作です');
  // Count editing leaves across the entire HTTP request. Batch containers,
  // including empty batches, do not consume the existing 50-operation budget.
  if (type !== 'batch' && ++budget.leafCount > MAX_SEQUENCE_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
  if(isNativeSpeedCommandType(type))validateNativeSpeedCommand(command);
  if(type==='set-scene-fades')validateSceneFadeEdit(command.targets,command.change);
  // 転換の形だけをここで見る。つなぎ目との一致・重なりの妥当性は set-transition と
  // 文書検証が持つ（UI は planTransition の結果をそのまま渡す）。
  if(type==='set-transition'){
    if(typeof command.joinKey!=='string'||!command.joinKey||command.joinKey.length>512)throw new HttpError(400,'つなぎ目の指定が不正です');
    if(command.transition!==null){
      const transition=object(command.transition);
      // SequenceTransition（id を除く）が持ちうるキーだけを許す。未知キーはここで弾く。
      const allowed=['trackId','outClipId','inClipId','kind','startFrame','durationFrames','edge','audioCurve','joinKey','joinFrame'];
      if(Object.keys(transition).some(key=>!allowed.includes(key)))throw new HttpError(400,'転換の内容が不正です');
      for(const key of ['trackId','outClipId','inClipId','kind'])if(typeof transition[key]!=='string'||!transition[key])throw new HttpError(400,'転換の内容が不正です');
      integer(transition.startFrame);integer(transition.durationFrames);
      if((transition.durationFrames as number)<1)throw new HttpError(400,'転換の長さが不正です');
      if(transition.edge!==undefined&&transition.edge!=='in'&&transition.edge!=='out')throw new HttpError(400,'転換の内容が不正です');
      if(transition.audioCurve!==undefined&&transition.audioCurve!=='linear'&&transition.audioCurve!=='none')throw new HttpError(400,'転換の内容が不正です');
      if(transition.joinKey!==undefined&&(typeof transition.joinKey!=='string'||!transition.joinKey))throw new HttpError(400,'転換の内容が不正です');
      if(transition.joinFrame!==undefined)integer(transition.joinFrame);
    }
  }
  if (type === 'remove-asset') id(command.assetId);
  // 文字スタイルの一括適用・表示切替。番号の実在はカタログを持つ document 側が見る。
  if (type === 'apply-text-style-all') {
    if (command.trackId !== undefined) id(command.trackId);
    id(command.assetId); integer(command.styleId); if ((command.styleId as number) < 1) throw new HttpError(400, 'スタイル番号が不正です');
    if (command.clearUnsupportedAnimations !== undefined && typeof command.clearUnsupportedAnimations !== 'boolean') throw new HttpError(400, '動きの解除指定が不正です');
  }
  if (type === 'set-text-style-hidden') {
    id(command.assetId);
    if (!Array.isArray(command.hidden) || command.hidden.length > 200) throw new HttpError(400, '表示設定が不正です');
    for (const value of command.hidden) integer(value);
  }
  // 追加パックの一覧登録だけがこの経路を使う。保存済みバイトとの一致は /command の実行前に確かめる。
  if (type === 'register-assets') {
    if (!Array.isArray(command.assets) || !command.assets.length || command.assets.length > 20) throw new HttpError(400, '登録する素材の一覧が不正です');
    for (const value of command.assets) {
      const asset = object(value); id(asset.id);
      if (asset.kind !== 'component') throw new HttpError(400, 'この操作で登録できるのは描画部品だけです');
    }
  }
  // 音声補正の参照切替。形だけをここで見る（素材の実在・音声ストリームの一致は文書側が持つ）。
  if (type === 'replace-audio-source') { id(command.trackId); id(command.fromAssetId); id(command.toAssetId); }
  // 文字スタイルの参照切替。形だけをここで見る（資産の実在・部品かどうかは文書側が持つ）。
  if (type === 'replace-text-style-asset') { id(command.fromAssetId); id(command.toAssetId); }
  if (type === 'batch') {
    if (depth >= 4 || !Array.isArray(command.commands) || command.commands.length > MAX_SEQUENCE_COMMAND_LEAVES) throw new HttpError(400, 'まとめる編集操作が多すぎます');
    for (const child of command.commands) {
      const parsed = editRequest({ ...body, command: child }, depth + 1, budget);
      if (parsed.command.type === 'undo' || parsed.command.type === 'redo') throw new HttpError(400, '履歴操作はまとめて実行できません');
    }
  }
  if (['split', 'delete', 'move', 'unlink'].includes(String(type))
    && (!Array.isArray(command.clipIds) || !command.clipIds.every(v => typeof v === 'string' && v.length))) throw new HttpError(400, '対象クリップの一覧が不正です');
  if (command.linked !== undefined && typeof command.linked !== 'boolean') throw new HttpError(400, '連動設定が不正です');
  if (type === 'ripple-delete') { integer(command.startFrame); integer(command.endFrame); }
  if(type==='resize-cut-boundary')validateResizeCutBoundaryCommand(command);
  if(type==='adopt-source-gap')validateAdoptSourceGap(command);
  if(type==='restore-cut') {id(command.entryId);validateRestoreCutCommand(command);}
  if(type==='fill-cut-captions')id(command.templateClipId);
  if(type==='split-caption'){id(command.clipId);integer(command.frame);if(typeof command.leftText!=='string'||typeof command.rightText!=='string')throw new HttpError(400,'字幕本文が不正です');}
  if(type==='merge-captions'){id(command.firstClipId);id(command.secondClipId);}
  if (type === 'split' || type === 'trim') integer(command.frame);
  if (type === 'move' && !Number.isSafeInteger(command.deltaFrames)) throw new HttpError(400, '移動量が不正です');
  if (type === 'trim' && command.edge !== 'start' && command.edge !== 'end') throw new HttpError(400, 'トリム端点が不正です');
  // 詰める（リップル）の切替。省略は従来動作。受理集合は union 導出のまま（コマンド型は増えない）。
  if (type === 'trim' && command.ripple !== undefined && typeof command.ripple !== 'boolean') throw new HttpError(400, '詰める指定が不正です');
  if (type === 'trim' || type === 'update-clip') id(command.clipId);
  if (type === 'add-track') { object(command.track); if (command.index !== undefined) integer(command.index); }
  if (type === 'insert' && !Array.isArray(command.clips)) throw new HttpError(400, '挿入クリップの一覧が不正です');
  if (type === 'set-track-enabled') { id(command.trackId); if (typeof command.enabled !== 'boolean') throw new HttpError(400, 'トラック設定が不正です'); }
  if (type === 'move-track') { id(command.trackId); integer(command.index); }
  if (type === 'remove-track') id(command.trackId);
  if (type === 'update-clip') object(command.patch);
  if(type==='set-ducking'){
    const patch=object(command.patch);
    if(Object.keys(patch).some(key=>!['enabled','strength'].includes(key))||('enabled' in patch&&typeof patch.enabled!=='boolean')
      ||('strength' in patch&&!['weak','mid','strong'].includes(String(patch.strength))))throw new HttpError(400,'BGMの自動音量調整の設定が不正です');
  }
  if(type==='set-script' && command.script!==null)object(command.script);
  return { sessionId: id(body.sessionId), executionId: id(body.executionId), expectedRevision: integer(body.expectedRevision), command: command as EditRequest['command'] };
}

/**
 * register-assets で受けた描画部品が、管理領域に保存済みのバイトと一致することを実行前に確かめる。
 * `/register` が取り込み済み素材に対して行う検証と同じ役割（部品は `.harness/components` にあり
 * 素材台帳には載らないため、この経路だけが追加パックの登録口になる）。
 */
async function assertRegisteredComponents(directory: string, command: EditRequest['command']): Promise<void> {
  if (command.type === 'batch') { for (const child of command.commands) await assertRegisteredComponents(directory, child); return; }
  if (command.type !== 'register-assets') return;
  for (const asset of command.assets) {
    try { await readSequenceComponent(directory, asset); }
    catch { throw new HttpError(400, '保存済みの描画部品と一致しません。取り込みからやり直してください。'); }
  }
}

/** Called inside the existing local-origin guard. No client filesystem paths are accepted. */
export async function handleSequenceApi(req: IncomingMessage, res: ServerResponse, url: URL, root: string, sessions = service, editor?:EditorAgentService): Promise<boolean> {
  if (url.pathname !== '/api/sequence' && !url.pathname.startsWith('/api/sequence/')) return false;
  const controller = new AbortController(), abort = () => controller.abort();
  const closed = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort); res.once('close', closed);
  try {
    if(url.pathname==='/api/sequence/reference-match'){
      if(req.method!=='POST')throw new HttpError(405,'素材照合は POST のみ対応します');
      sendJson(res,200,await matchSequenceReference(await readJsonBody(req,4096),browseRoots(),root,controller.signal));return true;
    }
    const projectId = url.searchParams.get('id');
    if (!projectId) throw new HttpError(400, 'プロジェクトIDが必要です');
    const directory = resolveProjectDir(root, projectId);
    if (resolve(root) === resolve(directory) || !existsSync(directory)) throw new HttpError(404, '対象のプロジェクトがありません');
    const route = url.pathname.slice('/api/sequence'.length), method = req.method ?? 'GET';
    if(route==='/transcribe' || route.startsWith('/transcribe/')) {
      const mutation=['/transcribe','/transcribe/apply','/transcribe/cancel'].includes(route);
      if(method!==(mutation?'POST':'GET'))throw new HttpError(405,'文字起こし操作のメソッドが不正です');
      if(route==='/transcribe/list')sendJson(res,200,{jobs:sequenceTranscriptions.list(directory)});
      else if(route==='/transcribe') {
        const body=object(await readJsonBody(req));
        sendJson(res,200,sequenceTranscriptions.start(directory,projectId,{sessionId:id(body.sessionId),expectedRevision:integer(body.expectedRevision),executionId:id(body.executionId),occurrenceId:id(body.occurrenceId)},sessions,()=>{
          if(!heavyJobGate(false,{counts:heavyJobCounts()}).allowed)throw new HttpError(429,'ほかの重い処理が進行中です。完了してから文字起こしを開始してください');
        }));
      }else {
        const jobId=id(url.searchParams.get('job'));
        if(route==='/transcribe/status')sendJson(res,200,{...sequenceTranscriptions.job(directory,jobId).data.status});
        else if(route==='/transcribe/result')sendJson(res,200,{transcript:sequenceTranscriptions.result(directory,jobId)});
        else if(route==='/transcribe/cancel')sendJson(res,200,sequenceTranscriptions.cancel(directory,jobId));
        else if(route==='/transcribe/apply') {
          const body=object(await readJsonBody(req));sendJson(res,200,await sequenceTranscriptions.apply(directory,jobId,
            {sessionId:id(body.sessionId),expectedRevision:integer(body.expectedRevision),executionId:id(body.executionId)},sessions));
        }else throw new HttpError(404,'文字起こしの操作が見つかりません');
      }
      return true;
    }
    if (route === '/export' || route.startsWith('/export/')) {
      const mutation = route === '/export' || route === '/export/cancel' || route === '/export/preflight';
      if (method !== (mutation ? 'POST' : 'GET')) throw new HttpError(405, '書き出し操作のメソッドが不正です');
      const preflight=async(sessionId:string,revision:number)=>{
        const state=sessions.open(directory);
        if(state.sessionId!==sessionId||state.document.revision!==revision||state.dirty)throw new HttpError(409,'編集内容が変わっています。保存してから素材を確認してください');
        const result=await preflightSequenceExport(directory,state.document,controller.signal);
        const current=sessions.open(directory);
        if(current.sessionId!==sessionId||current.document.revision!==revision||current.dirty)throw new HttpError(409,'素材の確認中に編集内容が変わりました。保存して再確認してください');
        return result;
      };
      if(route==='/export/preflight'){
        const body=object(await readJsonBody(req));sendJson(res,200,await preflight(id(body.sessionId),integer(body.expectedRevision)));
      }else if (route === '/export') {
        const body = object(await readJsonBody(req)), port = req.socket.localPort;
        if (!port) throw new HttpError(500, 'ローカルサーバーのポートを確認できません');
        const request=exportRequestSchema.parse({sessionId:id(body.sessionId),expectedRevision:integer(body.expectedRevision),executionId:id(body.executionId),...(body.settings===undefined?{}:{settings:exportSettingsSchema.parse(body.settings)})});
        // Recover an already accepted request even if a source went offline later.
        // New requests must pass the same check even when bypassing the UI endpoint.
        if(!exports.lookup(directory,request.executionId)){
          const result=await preflight(request.sessionId,request.expectedRevision);
          if(result.issues.length)throw new HttpError(422,'素材を確認できないため、書き出しを開始していません。\n'+result.issues.map(issue=>`「${issue.name}」: ${issue.message}`).join('\n'));
        }
        sendJson(res, 200, exports.start(directory, projectId, `http://127.0.0.1:${port}`,
          request, () => sessions.open(directory), () => {
            if (!heavyJobGate(false,{counts:heavyJobCounts()}).allowed) throw new HttpError(429,'ほかの重い処理が進行中です。完了してから書き出してください');
          }));
      } else if (route === '/export/list') sendJson(res, 200, exports.page(directory,Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit')??20)));
      else if (route === '/export/request') sendJson(res,200,{job:exports.lookup(directory,id(url.searchParams.get('executionId')))??null});
      else {
        const jobId = id(url.searchParams.get('job')), job = exports.job(directory, jobId);
        if (route === '/export/cancel') sendJson(res, 200, exports.cancel(directory, jobId));
        else if (route === '/export/status') sendJson(res, 200, { ...job.status });
        else if (route === '/export/input') sendJson(res, 200, { document: job.plan.document, contentHash: job.status.contentHash });
        else if (route === '/export/verify') {
          await exports.download(directory,jobId,controller.signal);sendJson(res,200,{ready:true});
        }
        else if (route === '/export/download') {
          if (job.status.phase !== 'complete' || !job.directory) throw new HttpError(409, '動画の書き出しはまだ完了していません');
          const output=await exports.download(directory,jobId,controller.signal);
          res.setHeader('Content-Disposition', nativeExportContentDisposition(basename(directory)));
          serveAsset(res, output, req.headers.range);
        } else if (route === '/export/asset' || route === '/export/component') {
          const asset = job.plan.document.assets.find(asset => asset.id === url.searchParams.get('asset'));
          if (!asset) throw new HttpError(404, '書き出し版に指定の素材がありません');
          if (route === '/export/component') sendText(res, 200, await readSequenceComponent(directory, asset), 'text/javascript; charset=utf-8');
          else await serveSequenceAsset(res,directory,asset,req.headers.range,controller.signal);
        } else throw new HttpError(404, '書き出し操作が見つかりません');
      }
      return true;
    }
    const post = ['/proxy', '/external-edit', '/migrate', '/session', '/session/status', '/session/reload', '/command', '/agent', '/save', '/discard', '/upload', '/register','/reference','/reference/reconnect','/text-styles','/script/alignment','/script/edit-input','/script/edit-review','/legacy-cuts/prepare','/legacy-cuts/adopt'].includes(route);
    const get = ['/proxies', '/external-edits', '', '/assets', '/asset', '/component', '/audio', '/audio/data', '/waveform', '/legacy-status','/reference/status'].includes(route);
    if (!post && !get) throw new HttpError(404, '新形式のAPIが見つかりません');
    if (method !== (post ? 'POST' : 'GET')) throw new HttpError(405, `この操作は ${post ? 'POST' : 'GET'} のみ対応します`);
    let waveform;
    if(route==='/waveform'){
      try{waveform=waveformRequestFromQuery(url.searchParams);}
      catch(error){throw new HttpError(400,error instanceof Error?error.message:'波形の入力が不正です');}
    }
    if (route === '/upload') {
      if (!new SequenceStore(directory).load()) throw new HttpError(409, '先に案件を新形式へ移行してください');
      const name = basename((url.searchParams.get('name') ?? '').replaceAll('\\', '/')).normalize('NFC').trim();
      if (!name || name.startsWith('.') || !/\.[A-Za-z0-9]+$/.test(name)) throw new HttpError(400, '素材名が不正です');
      const maximum = resolveMaxUploadBytes(); assertContentLengthWithin(req, maximum);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'harness-native-upload-'));
      try {
        const file = await streamBodyToTempFile(req, temporaryDirectory, maximum);
        const imported = await importSequenceAsset(directory, file, name, controller.signal);
        sendJson(res, 200, { asset: await withImportRole(directory, imported, url.searchParams.get('role')) });
      } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
      return true;
    }
    if (post) {
      const body = object(await readJsonBody(req));
      if(route==='/proxy') {
        const current=sessions.inspect(directory,id(body.sessionId));
        const asset=current.document.assets.find(asset=>asset.id===id(body.assetId));
        if(!asset)throw new HttpError(404,'素材がありません');
        if(!heavyJobGate(false,{counts:heavyJobCounts()}).allowed)throw new HttpError(429,'ほかの重い処理の完了を待ってください');
        sendJson(res,200,startNativeProxy(directory,asset));return true;
      }
      if(route==='/external-edit') {
        const result=applyExternalEdit(directory,{metadata:body.metadata,document:body.document as SequenceDocument,before:body.before},()=>sessions.assertExternalWritable(directory));
        sendJson(res,result.status==='conflict'?409:result.status==='failed'?422:200,result);return true;
      }
      if(route==='/reference'||route==='/reference/reconnect'){
        if(!new SequenceStore(directory).load())throw new HttpError(409,'先に案件を新形式へ移行してください');
        if(typeof body.path!=='string'||!body.path||body.path.length>4096)throw new HttpError(400,'素材の場所が不正です');
        const source=assertBrowsablePath(body.path,browseRoots());
        if(route==='/reference'){
          const referenced=await registerSequenceReference(directory,source,basename(source),controller.signal,expectedReferenceFingerprint(body.expectedFingerprint));
          sendJson(res,200,{asset:await withImportRole(directory,referenced,typeof body.role==='string'?body.role:null)});
        }
        else{
          const asset=sessions.open(directory).document.assets.find(a=>a.id===body.assetId);
          if(!asset)throw new HttpError(404,'接続する素材がありません');
          await reconnectSequenceReference(directory,asset,source,controller.signal);sendJson(res,200,{asset,status:await sequenceReferenceStatus(directory,asset,controller.signal)});
        }
        return true;
      }
      if(route==='/script/alignment'||route==='/script/edit-input') {
        if(body.mode!=='caption' && body.mode!=='structure')throw new HttpError(400,'照合の目的が不正です');
        const collect=route==='/script/alignment'?collectSequenceScriptAlignment:collectNativeScriptEditInput;
        sendJson(res,200,await collect(directory,projectId,{sessionId:id(body.sessionId),expectedRevision:integer(body.expectedRevision),
          occurrenceId:id(body.occurrenceId),mode:body.mode},sessions,controller.signal));
      }
      else if(route==='/script/edit-review') {
        const state=sessions.open(directory);
        if(state.sessionId!==id(body.sessionId)||state.document.revision!==integer(body.expectedRevision)||state.dirty)
          throw new HttpError(409,'現在の編集内容を保存してから台本案を確認してください');
        const modification=body.modification===undefined?undefined:scriptEditModificationSchema.parse(body.modification);
        const preview=assertNativeScriptEditCurrent(directory,projectId,body.artifact,state.document,modification);
        sendJson(res,200,{artifact:preview.artifact,before:preview.before,after:preview.after,plan:resolveScriptEditPlan(preview.artifact,modification)});
      }
      else if(route==='/legacy-cuts/prepare'||route==='/legacy-cuts/adopt'){
        const fields=route==='/legacy-cuts/prepare'?['sessionId','expectedRevision']:['sessionId','expectedRevision','executionId','planId','planDigest'];
        if(Object.keys(body).some(key=>!fields.includes(key)))throw new HttpError(400,'旧カットの要求に未対応の項目があります');
        let backfills=legacyBackfillsByService.get(sessions);if(!backfills){backfills=new LegacyCutBackfills(sessions);legacyBackfillsByService.set(sessions,backfills);}
        const owner={sessionId:id(body.sessionId),expectedRevision:integer(body.expectedRevision)};
        if(route==='/legacy-cuts/prepare')sendJson(res,200,await backfills.prepare(directory,owner,controller.signal));
        else sendJson(res,200,await backfills.adopt(directory,{...owner,executionId:id(body.executionId),planId:id(body.planId),planDigest:id(body.planDigest)},controller.signal));
      }
      else if (route === '/agent') {
        const request=editorChangeSetSchema.parse(body.request);
        assertEditorDeliveryMayApply(req.headers,projectId,request,editor);
        sendJson(res,200,sessions.applyEditor(directory,projectId,id(body.sessionId),request));
      }
      else if (route === '/migrate') sendJson(res, 200, await migrateSequenceProject(directory, id(body.executionId), controller.signal));
      else if (route === '/session') sendJson(res, 200, sessions.open(directory, true));
      else if (route === '/session/status') sendJson(res, 200, sessions.inspect(directory, id(body.sessionId), true));
      else if (route === '/session/reload') sendJson(res, 200, sessions.reload(directory, id(body.sessionId), integer(body.expectedRevision), integer(body.savedRevision), id(body.contentHash), body.onlyIfClean === true));
      else if (route === '/command') {
        const request = editRequest(body);
        await assertRegisteredComponents(directory, request.command);
        sendJson(res, 200, sessions.execute(directory, request));
      }
      else if(route==='/text-styles') {
        const current=sessions.open(directory);
        if(current.sessionId!==id(body.sessionId)||current.document.revision!==integer(body.expectedRevision))throw new HttpError(409,'編集状態が変わりました');
        const prepared=await prepareNativeTextStyleAssets(directory,current.document);
        const assets=textStyleAssetsToRegister(current.document,prepared);
        // No asset actually changes the document (catalog already registered): don't execute, so
        // merely selecting a telop clip never advances the revision or marks the document dirty.
        if(!assets.length){sendJson(res,200,current);return true;}
        sendJson(res,200,sessions.execute(directory,{sessionId:id(body.sessionId),executionId:id(body.executionId),expectedRevision:integer(body.expectedRevision),command:{type:'register-assets',assets}}));
      }
      else if (route === '/register') {
        if (!Array.isArray(body.assetIds) || !body.assetIds.length || body.assetIds.some(value => typeof value !== 'string')) throw new HttpError(400, '登録する素材IDが必要です');
        const registry = await registeredSequenceAssets(directory);
        const assets = body.assetIds.map(value => { const asset = registry.find(item => item.id === value); if (!asset) throw new HttpError(404, '取り込み済みの素材がありません'); return asset; });
        for (const asset of assets) await verifiedSequenceAssetPath(directory, asset, controller.signal);
        sendJson(res, 200, sessions.execute(directory, { sessionId: id(body.sessionId), executionId: id(body.executionId), expectedRevision: integer(body.expectedRevision),
          command: { type: 'register-assets', assets } }));
      }
      else if (route === '/discard') sendJson(res, 200, sessions.discard(directory, id(body.sessionId), integer(body.expectedRevision)));
      else {
        assertEditorDeliveryMaySave(req.headers,projectId,editor,sequenceEditorRevision(id(body.sessionId),integer(body.expectedRevision)));
        sendJson(res, 200, sessions.save(directory, { sessionId: id(body.sessionId), executionId: id(body.executionId),
          expectedRevision: integer(body.expectedRevision), expectedSavedRevision: integer(body.expectedSavedRevision) }));
      }
      return true;
    }
    const saved = new SequenceStore(directory).load();
    if (route === '') { sendJson(res, 200, saved ?? { document: null }); return true; }
    if (!saved) throw new HttpError(404, '新形式の編集データがありません');
    if(route==='/proxies') {
      const doc=url.searchParams.has('session')?sessions.inspect(directory,id(url.searchParams.get('session'))).document:saved.document;
      sendJson(res,200,{assets:doc.assets.filter(asset=>asset.streams.some(stream=>stream.kind==='video')).map(asset=>nativeProxyStatus(directory,asset))});return true;
    }
    if (route === '/external-edits') { sendJson(res,200,{records:listExternalEdits(directory)});return true; }
    if (route === '/assets') { sendJson(res, 200, { assets: await registeredSequenceAssets(directory) }); return true; }
    if (route === '/legacy-status') {
      let status: 'unchanged' | 'changed' | 'unavailable' | 'none' = 'none';
      if (saved.document.legacy) {
        try { status = await legacyInputFingerprint(directory) === saved.document.legacy.sourceFingerprint ? 'unchanged' : 'changed'; }
        catch { status = 'unavailable'; }
      }
      sendJson(res, 200, { status }); return true;
    }
    const assetId = url.searchParams.get('asset');
    // Components added during editing must be previewable before Save, just like uploaded media.
    const asset = (route==='/component'?sessions.open(directory).document.assets.find(item=>item.id===assetId):undefined)
      ?? saved.document.assets.find(item => item.id === assetId)
      ?? (await registeredSequenceAssets(directory)).find(item => item.id === assetId);
    if (!asset) throw new HttpError(404, '指定された素材がありません');
    if(route==='/reference/status'){sendJson(res,200,await sequenceReferenceStatus(directory,asset,controller.signal));return true;}
    if (route === '/component') { sendText(res, 200, await readSequenceComponent(directory, asset), 'text/javascript; charset=utf-8'); return true; }
    if(waveform){sendJson(res,200,await prepareSequenceWaveform(directory,asset,waveform,controller.signal));return true;}
    if (route === '/asset' && url.searchParams.get('preview')==='1') {
      // The preview reports which file it read, so a timeout names the original or the proxy.
      const proxy=nativeProxyPath(directory,asset);
      if(proxy){await verifiedSequenceAssetPath(directory,asset,controller.signal);res.setHeader('x-harness-preview-source','proxy');serveAsset(res,proxy,req.headers.range);return true;}
      res.setHeader('x-harness-preview-source','original');
    }
    if (route === '/asset') { await serveSequenceAsset(res,directory,asset,req.headers.range,controller.signal); return true; }
    await verifiedSequenceAssetPath(directory, asset, controller.signal);
    if (!url.searchParams.has('stream')) throw new HttpError(400, '音声ストリーム番号が必要です');
    const stream = integer(Number(url.searchParams.get('stream')));
    const rate = rational(Number(url.searchParams.get('rateNum') ?? '1'), Number(url.searchParams.get('rateDen') ?? '1'));
    const pcm = await prepareSequenceAudio(directory, asset, stream, rate, controller.signal);
    if (route === '/audio/data') serveAsset(res, pcm.file, req.headers.range);
    else sendJson(res, 200, { sampleRate: pcm.sampleRate, channels: pcm.channels, sampleCount: pcm.sampleCount, rate: pcm.rate,
      url: `/api/sequence/audio/data?${new URLSearchParams({ id: projectId, asset: asset.id, stream: String(stream), rateNum: String(rate.num), rateDen: String(rate.den) })}` });
    return true;
  } catch (error) {
    if (controller.signal.aborted) return true;
    if(res.headersSent){res.destroy(error instanceof Error?error:undefined);return true;}
    const status = error instanceof HttpError ? error.status : error instanceof SequenceError
      ? error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'MISSING_TARGET' ? 404 : 400 : 422;
    sendJson(res, status, { error: error instanceof Error ? error.message : '編集データの処理に失敗しました',
      ...(error instanceof SequenceError ? { code: error.code, targets: error.targets } : {}) });
    return true;
  } finally { req.off('aborted', abort); res.off('close', closed); }
}

/**
 * 「BGM として取り込んだ」「効果音として取り込んだ」を素材の由来に残す（B の分類規則 5）。
 * 音声だけの素材に限る。映像を持つ素材や LUT では何も書かない。
 */
async function withImportRole(directory: string, asset: SequenceAsset, role: string | null): Promise<SequenceAsset> {
  if (role !== 'music' && role !== 'effect') return asset;
  if (asset.kind !== 'media' || asset.streams.some(stream => stream.kind === 'video') || !asset.streams.some(stream => stream.kind === 'audio')) return asset;
  return registerAssetOrigin(directory, asset.id, {kind: 'import', role});
}
