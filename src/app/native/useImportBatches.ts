import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useEventChannelWithSync} from '../eventBus';
import type {SequenceDocument} from '../../core/sequence/model';
import type {ImportBatchView,ImportItemView} from '../../shared/importBatches';
import {cancelImportBatch,createImportBatch} from './api';
import {importFrames,unplacedConfirmedImports,type ImportFrame} from './importFrames';
import {forgetImportSeconds,importSeconds,noteImportSeconds,subscribeImportSeconds,takeOverImportSeconds} from './importSeconds';

const OPEN=new Set<ImportBatchView['phase']>(['preparing','deciding','ready','partial','failed','confirming']);
/** SSE imports チャネルの一覧型メッセージ。 */
export function importListMessage(raw:unknown):ImportBatchView[]|null{
  if(!raw||typeof raw!=='object'||(raw as {type?:unknown}).type!=='list'||!Array.isArray((raw as {batches?:unknown}).batches))return null;
  return (raw as {batches:ImportBatchView[]}).batches;
}
/**
 * 案件の取り込みの束（設計 §1・§2-6）。準備完了の束のうち、この画面が作った束・ホーム・AI の束は1回だけ自動で確定する。
 * それ以外（開いていない間に準備が終わった束）と失敗を含む束は「準備済み・未配置」として確定を促す。
 */
/** 確定中（confirming）のまま、この時間を過ぎた束は「配置が止まっています」と案内する（サーバは再起動で未確定に戻す）。 */
export const IMPORT_CONFIRM_STALL_MS=30_000;
type Marks={working:ReadonlySet<string>;placed:ReadonlySet<string>;retry:ReadonlySet<string>};
const NO_MARKS:Marks={working:new Set(),placed:new Set(),retry:new Set()};
/** onPlaced: この画面が確定できた束（確定を始めた時と同じ案件の間だけ）。 */
export function useImportBatches(projectId:string,options:{ready:boolean;confirm(batchId:string,skipFailed:boolean):Promise<boolean>;onPlaced?(batch:ImportBatchView):void}){
  // working=確定中、placed=この画面で確定できた（SSE の confirmed を待つ間も促さない）、retry=自動確定に失敗した（手で並べ直せるよう促す）
  const [batches,setBatches]=useState<ImportBatchView[]>([]),[marks,setMarks]=useState<Marks>(NO_MARKS);
  // listedFor: 一覧が届いた案件（開いてから最初の一覧が届いたか。画面が「開いた時に確定を促す」の判断に使う）。案件を切り替えると届くまで null。
  const [listedFor,setListedFor]=useState<string|null>(null);
  const own=useRef(new Set<string>()),attempted=useRef(new Set<string>()),live=useRef(options);live.current=options;
  // 長さの先読みは画面全体で共有する（ホームで読んだ分も出す）。届くたびに枠を描き直す。
  const [secondsVersion,setSecondsVersion]=useState(0);useEffect(()=>subscribeImportSeconds(()=>setSecondsVersion(version=>version+1)),[]);
  // ownVersion: remember で自分の束が増えたら自動確定の判断をやり直す（一覧が remember より先に届いた束も自動で確定する）。
  const [ownVersion,setOwnVersion]=useState(0),[stalled,setStalled]=useState<ReadonlySet<string>>(new Set()),confirmingSince=useRef(new Map<string,number>());
  // uploads: この画面が作ったコピーの束への送信を止める合図（送り終えたら手放す）。取り消し（ここ・他の画面）、案件の切り替え、画面を閉じた時に止める。epoch は案件ごとの世代。
  const uploads=useRef(new Map<string,AbortController>()),epoch=useRef(0),latestBatches=useRef(batches);latestBatches.current=batches;
  useEffect(()=>{setBatches([]);setListedFor(null);setMarks(NO_MARKS);setStalled(new Set());own.current=new Set();attempted.current=new Set();confirmingSince.current=new Map();
    takeOverImportSeconds(projectId);   // ページを読み直す移動の前に残した、この案件の束の長さ
    return ()=>{epoch.current++;for(const controller of uploads.current.values())controller.abort(new Error('案件を切り替えたため送信を止めました'));uploads.current=new Map();};
  },[projectId]);
  useEventChannelWithSync('imports',projectId,raw=>{const list=importListMessage(raw);if(list){setBatches(list.filter(batch=>batch.projectId===projectId));setListedFor(projectId);}});
  useEffect(()=>{for(const batch of batches){
    if(batch.phase==='cancelled')uploads.current.get(batch.batchId)?.abort(new Error('取り込みを取り消しました'));
    if(batch.phase==='cancelled'||batch.phase==='confirmed')forgetImportSeconds(batch.batchId);}},[batches]);
  const automatic=useCallback((batch:ImportBatchView)=>batch.origin.kind!=='ui'||own.current.has(batch.batchId),[ownVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  const confirm=useCallback(async(batchId:string,skipFailed:boolean)=>{
    const generation=epoch.current;
    attempted.current.add(batchId);setMarks(m=>({...m,working:new Set([...m.working,batchId])}));let ok=false;
    try{
      ok=await live.current.confirm(batchId,skipFailed);
      const batch=latestBatches.current.find(item=>item.batchId===batchId);
      if(ok&&batch&&generation===epoch.current)live.current.onPlaced?.(batch);
      return ok;
    }
    finally{setMarks(m=>{const working=new Set(m.working);working.delete(batchId);
      return {working,placed:ok?new Set([...m.placed,batchId]):m.placed,retry:ok?m.retry:new Set([...m.retry,batchId])};});}
  },[]);
  useEffect(()=>{
    if(!options.ready)return;
    // 案件を切り替えた直後の描画では、batches にまだ前の案件の束が残っている（片付けの effect と同じ回に走る）。
    for(const batch of batches)if(batch.projectId===projectId&&batch.phase==='ready'&&!attempted.current.has(batch.batchId)&&automatic(batch))void confirm(batch.batchId,false);
  },[batches,options.ready,automatic,confirm,projectId]);
  useEffect(()=>{
    // 確定中の束を見始めた時刻を覚え、IMPORT_CONFIRM_STALL_MS を過ぎたものを stalled にする。
    const since=confirmingSince.current,now=Date.now();
    for(const id of [...since.keys()])if(!batches.some(batch=>batch.batchId===id&&batch.phase==='confirming'))since.delete(id);
    for(const batch of batches)if(batch.phase==='confirming'&&!since.has(batch.batchId))since.set(batch.batchId,now);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=()=>{const at=Date.now(),entries=[...since],next=entries.filter(([,start])=>at-start>=IMPORT_CONFIRM_STALL_MS).map(([id])=>id);
      setStalled(prev=>prev.size===next.length&&next.every(id=>prev.has(id))?prev:new Set(next));
      // まだ時間に達していない束があれば、残り時間で張り直す（タイマーが早めに届いても見落とさない）。
      const waits=entries.map(([,start])=>start+IMPORT_CONFIRM_STALL_MS-at).filter(ms=>ms>0);
      timer=waits.length?setTimeout(update,Math.min(...waits)):undefined;};
    update();
    return ()=>clearTimeout(timer);
  },[batches]);
  const cancel=useCallback(async(batchId:string):Promise<string|null>=>{
    try{await cancelImportBatch(projectId,batchId);}catch(error){return error instanceof Error?error.message:String(error);}
    uploads.current.get(batchId)?.abort(new Error('取り込みを取り消しました'));return null;
  },[projectId]);
  const remember=useCallback((view:ImportBatchView,known?:ReadonlyMap<string,number>)=>{
    own.current.add(view.batchId);if(known?.size)noteImportSeconds(view.batchId,known);setOwnVersion(version=>version+1);
    setBatches(list=>list.some(batch=>batch.batchId===view.batchId)?list:[...list,view]);
  },[]);
  /** この画面で束を作る（自分の束＝準備完了で自動確定）。並べ順はサーバが受付時に固定する。 */
  const start=useCallback(async(input:{mode:'link'|'copy';items:Array<{key:string;name:string;path?:string}>;seconds?:ReadonlyMap<string,number>}):Promise<ImportBatchView>=>{
    const generation=epoch.current,view=await createImportBatch(projectId,{requestId:crypto.randomUUID(),mode:input.mode,origin:'ui',items:input.items});
    // 作る間に案件が変わったら、次の案件の束としては覚えない（送信の合図も作らない＝送らない）。送信の合図は画面から送るコピーの束だけ。
    if(generation===epoch.current){if(input.mode==='copy')uploads.current.set(view.batchId,new AbortController());remember(view,input.seconds);}
    return view;
  },[projectId,remember]);
  /** この画面が作った束へ送る間の合図。取り消し・案件の切り替えで止まる。知らない束（作る間に案件が変わった等）は止まった合図。 */
  const uploadSignal=useCallback((batchId:string):AbortSignal=>uploads.current.get(batchId)?.signal??AbortSignal.abort(new Error('送信先の取り込みがありません')),[]);
  /** 送り終えた束の合図を手放す（以後の取り消しは送信に関わらない）。 */
  const releaseUploads=useCallback((batchId:string)=>{uploads.current.delete(batchId);},[]);
  const open=useMemo(()=>batches.filter(batch=>OPEN.has(batch.phase)),[batches]);
  // 判断待ちの束（decision）は自動確定の束でも促す（決めるまで確定しない。設計 §2）
  const pending=useMemo(()=>open.filter(batch=>!marks.working.has(batch.batchId)&&!marks.placed.has(batch.batchId)&&(batch.decision!==undefined||batch.phase==='partial'||batch.phase==='failed'
    ||(batch.phase==='ready'&&(!automatic(batch)||marks.retry.has(batch.batchId)))||(batch.phase==='confirming'&&stalled.has(batch.batchId)))),[open,marks,automatic,stalled]);
  const frames=useCallback((doc:SequenceDocument):ImportFrame[]=>importFrames(doc,open,(batchId:string,item:ImportItemView)=>importSeconds(batchId,item.key)),[open,secondsVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  /** 確定の印はあるのに文書に無い束（案内だけ。再び確定はしない）。この画面が確定中・確定できた束は除く（一覧の confirmed が確定の応答より先に届くため）。 */
  const unplaced=useCallback((doc:SequenceDocument):ImportBatchView[]=>unplacedConfirmedImports(doc,batches).filter(batch=>!marks.working.has(batch.batchId)&&!marks.placed.has(batch.batchId)),[batches,marks]);
  // all: 案件の全部の束（確定済み・取り消し済みを含む。項目の choice を素材 ID へ引き継ぐのに使う）。切り替えた直後の描画では前の案件の束が残りうるので、使う側で projectId を確かめる
  return {batches:open,all:batches,pending,frames,unplaced,confirm,cancel,remember,start,uploadSignal,releaseUploads,listed:listedFor===projectId};
}
