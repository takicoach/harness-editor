import {editRequest,object,id,integer,SEQUENCE_API_COMMAND_TYPES} from './editRequest';
export {editRequest,SEQUENCE_API_COMMAND_TYPES};
import {nativeProxyPath,nativeProxyStatus,startNativeProxy} from './previewProxy';
import type {SequenceDocument} from '../../core/sequence/model';
import {applyExternalEdit,listExternalEdits} from './externalEdits';
import {LegacyCutBackfills} from './legacyCutBackfill';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpError, sendJson, sendText } from '../http';
import { libraryDirectory, LibraryError } from '../library/catalog';
import { prepareLibraryItem } from '../library/prepare';
import { placeLibraryItems } from '../library/place';
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
import { SequenceStore } from './store';
import {preflightSequenceExport} from './exportPreflight';
import {exportRequestSchema} from './exportRecords';
import { sequenceService as service, type SequenceStatusKnown } from './service';
import { legacyInputFingerprint, migrateSequenceProject } from './migration';
import { readSequenceComponent } from './components';
import {prepareNativeTextStyleAssets,textStyleAssetsToRegister} from './textStyles';
import type { SequenceAsset } from '../../core/sequence/model';
import { importSequenceAsset, registerAssetOrigin, registeredSequenceAssets, verifiedSequenceAssetPath } from './assets';
import { prepareSequenceAudio } from './media';
import {waveformRequestFromQuery} from './waveform';
import {respondWaveform,waveformPreparationStatuses} from './waveformJobs';
import {frameRequestFromQuery,prepareSequenceFrames} from './frameImages';
import {FfmpegBusyError} from './ffmpegGate';
import { sequenceExports as exports } from './exports';
import {exportSettingsSchema} from './exportRecords';
import { assertContentLengthWithin, resolveMaxUploadBytes, streamBodyToTempFile } from '../streamUpload';
import { assertEditorDeliveryMayApply, assertEditorDeliveryMaySave } from '../editorSaveGuard';
import {handleSilenceCutApi} from './silenceCutApi';
import {handleImportApi} from './importApi';
import {handleMediaCopyApi} from './mediaCopy/api';
import type { EditorAgentService } from '../editorAgentService';
import { editorChangeSetSchema } from '../../shared/editorCommands';
import { sequenceEditorRevision } from '../../core/sequence/editorCommands';
import { collectSequenceScriptAlignment } from './script';
import { collectNativeScriptEditInput,assertNativeScriptEditCurrent } from './scriptEdits';
import { scriptEditModificationSchema,resolveScriptEditPlan } from '../../core/scriptEditModification';
import { sequenceTranscriptions } from './transcriptions';
import { heavyJobCounts,heavyJobGate } from '../systemLoad';

const legacyBackfillsByService=new WeakMap<object,LegacyCutBackfills>();
/** 素材の索引だけで答える経路（設計 §2-4）。文書全体・版の判断が要る経路はここに入れない。 */
const READ_ONLY_ROUTES = ['/asset', '/component', '/audio', '/audio/data', '/waveform', '/waveform/status', '/frames', '/reference/status'];
function statusKnown(value: unknown): SequenceStatusKnown | undefined {
  if (value === undefined) return undefined;
  const known = object(value);
  if (!Number.isSafeInteger(known.revision) || !Number.isSafeInteger(known.savedRevision) || typeof known.savedContentHash !== 'string'
    || typeof known.canUndo !== 'boolean' || typeof known.canRedo !== 'boolean' || (known.historyError !== null && typeof known.historyError !== 'string'))
    throw new HttpError(400, '状態の問い合わせが不正です');
  return known as unknown as SequenceStatusKnown;
}
/** Keep the saved movie recognizable while avoiding separators and control characters in a filename. */
export function nativeExportContentDisposition(projectName:string):string {
  const safe=projectName.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,80)||'動画';
  return `attachment; filename="harness.mp4"; filename*=UTF-8''${encodeURIComponent(`ハーネス_${safe}.mp4`)}`;
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
    if(await handleSilenceCutApi(req,res,url,directory,sessions,controller.signal))return true;
    if(await handleImportApi(req,res,url,route,directory,projectId,sessions,controller.signal))return true;
    if(await handleMediaCopyApi(req,res,route,directory,projectId))return true;
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
    const post = ['/proxy', '/external-edit', '/migrate', '/session', '/session/status', '/session/reload', '/command', '/agent', '/save', '/discard', '/upload', '/register','/reference','/reference/reconnect','/text-styles','/script/alignment','/script/edit-input','/script/edit-review','/legacy-cuts/prepare','/legacy-cuts/adopt','/library/prepare','/library/place'].includes(route);
    const get = ['/proxies', '/external-edits', '', '/assets', '/asset', '/component', '/audio', '/audio/data', '/waveform', '/waveform/status', '/frames', '/legacy-status','/reference/status'].includes(route);
    if (!post && !get) throw new HttpError(404, '新形式のAPIが見つかりません');
    if (method !== (post ? 'POST' : 'GET')) throw new HttpError(405, `この操作は ${post ? 'POST' : 'GET'} のみ対応します`);
    if(route==='/waveform/status'){
      // 準備の識別子ごとの状態だけを返す（文書・素材は読まない）。
      const ids=(url.searchParams.get('preparation')??'').split(',').filter(Boolean);
      if(!ids.length||ids.length>64||ids.some(value=>!/^[a-f0-9]{32}$/.test(value)))throw new HttpError(400,'波形の準備IDが不正です');
      sendJson(res,200,{preparations:waveformPreparationStatuses(directory,ids)});return true;
    }
    let waveform;
    if(route==='/waveform'){
      try{waveform=waveformRequestFromQuery(url.searchParams);}
      catch(error){throw new HttpError(400,error instanceof Error?error.message:'波形の入力が不正です');}
    }
    let frames;
    if(route==='/frames'){
      try{frames=frameRequestFromQuery(url.searchParams);}
      catch(error){throw new HttpError(400,error instanceof Error?error.message:'コマ絵の入力が不正です');}
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
      if(route==='/library/prepare') {
        if(!new SequenceStore(directory).load())throw new HttpError(409,'先に案件を新形式へ移行してください');
        if(typeof body.key!=='string'||!body.key||body.key.length>200)throw new HttpError(400,'素材置場の項目指定が不正です');
        try{sendJson(res,200,{asset:await prepareLibraryItem(directory,libraryDirectory(),body.key,controller.signal)});}
        catch(error){if(error instanceof LibraryError)throw new HttpError(error.status,error.message);throw error;}
        return true;
      }
      if(route==='/library/place') {
        if(!new SequenceStore(directory).load())throw new HttpError(409,'先に案件を新形式へ移行してください');
        sendJson(res,200,await placeLibraryItems(directory,libraryDirectory(),sessions,body,controller.signal));
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
      else if (route === '/session/status') sendJson(res, 200, sessions.status(directory, id(body.sessionId), statusKnown(body.known)));
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
    const store = new SequenceStore(directory), readOnly = READ_ONLY_ROUTES.includes(route);
    const savedAssets = readOnly ? store.assetIndex() : null, saved = readOnly ? null : store.load();
    if (route === '') { sendJson(res, 200, saved ?? { document: null }); return true; }
    if (!saved && !savedAssets) throw new HttpError(404, '新形式の編集データがありません');
    if (saved) {
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
    }
    const assetId = url.searchParams.get('asset');
    // Components added during editing must be previewable before Save, just like uploaded media.
    const asset = (route==='/component'?sessions.open(directory).document.assets.find(item=>item.id===assetId):undefined)
      ?? (assetId === null ? undefined : savedAssets?.get(assetId))
      ?? (await registeredSequenceAssets(directory)).find(item => item.id === assetId);
    if (!asset) throw new HttpError(404, '指定された素材がありません');
    if(route==='/reference/status'){sendJson(res,200,await sequenceReferenceStatus(directory,asset,controller.signal));return true;}
    if (route === '/component') { sendText(res, 200, await readSequenceComponent(directory, asset), 'text/javascript; charset=utf-8'); return true; }
    if(waveform){
      // FFmpeg の待ち行列が満杯なのは一時的な混雑: 失敗（422）ではなく 503 で返す。
      try{sendJson(res,200,await respondWaveform(directory,asset,waveform,controller.signal));}
      catch(error){if(error instanceof FfmpegBusyError)throw new HttpError(503,error.message);throw error;}
      return true;
    }
    if(frames){
      // 波形と同じく、混雑は 503（ブラウザは待って取り直す）。
      try{sendJson(res,200,await prepareSequenceFrames(directory,asset,frames,controller.signal));}
      catch(error){if(error instanceof FfmpegBusyError)throw new HttpError(503,error.message);throw error;}
      return true;
    }
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
      ...(error instanceof SequenceError ? { code: error.code, targets: error.targets } : error instanceof HttpError && error.reason ? { code: error.reason } : {}) });
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
