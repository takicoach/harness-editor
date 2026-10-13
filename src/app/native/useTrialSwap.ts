import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SequenceDocument} from '../../core/sequence/model';
import {buildTrialSwap,type TrialEndMode,type TrialSwapResult} from '../../core/sequence/trialSwap';
import type {NativeCommand} from './api';

export interface TrialSwapBase {projectId:string;sessionId:string;document:SequenceDocument}
export interface TrialSwapState {base:TrialSwapBase;clipId:string;assetId:string;endMode:TrialEndMode;generation:number;result:Extract<TrialSwapResult,{ok:true}>;adopting:boolean}
/** 試せなかった理由。どのクリップで出たかを持ち、節はそのクリップの使用箇所でだけ出す。 */
export interface TrialSwapError {clipId:string;message:string}
type Outcome='ok'|'conflict'|'failed'|'unknown'|'cancelled';

const AUTO_END='内容が更新されたため試し表示を終了しました',CONFLICT='内容が更新されたため採用できませんでした。もう一度試してください',UNKNOWN='採用できたか確認できませんでした。タイムラインを確かめてください';

/** 試し差し替えの状態。プロジェクト・セッション・文書 id・版が開始時と一致する間だけ有効で、外れたら自動で解除する。 */
export function useTrialSwap(options:{
  current:{projectId:string;sessionId?:string;document?:SequenceDocument};
  executeAt(command:NativeCommand,base:{sessionId:string;revision:number}):Promise<Outcome>;
  onNotice(message:string):void;
  /** 採用の結果が不明なとき、知らせる前に状態を読み直す（設計 §4）。 */
  refresh?():Promise<void>|void;
}){
  const {current,executeAt,onNotice}=options;
  const refreshRef=useRef(options.refresh);
  const [state,setStateRaw]=useState<TrialSwapState|null>(null),[error,setError]=useState<TrialSwapError|null>(null);
  // 世代はフックの間ずっと増え続ける。開始のたびに1へ戻すと、並んだ開始が別の候補を同じ id・同じ版で作り、プレビューが後の方を無視する（NativePreview は同じ id で同じか古い版を捨てる）。
  const generation=useRef(0);
  const stateRef=useRef<TrialSwapState|null>(null),released=useRef<TrialSwapState|null>(null);
  const setState=useCallback((next:TrialSwapState|null)=>{stateRef.current=next;setStateRaw(next);},[]);
  const noticeRef=useRef(onNotice),mountedRef=useRef(true);
  useLayoutEffect(()=>{noticeRef.current=onNotice;refreshRef.current=options.refresh;});
  useEffect(()=>{mountedRef.current=true;return ()=>{mountedRef.current=false;};},[]);
  const doc=current.document;
  const active=!!state&&state.base.projectId===current.projectId&&state.base.sessionId===current.sessionId&&state.base.document.id===doc?.id&&state.base.document.revision===doc?.revision;
  const trial=active?state:null;
  useEffect(()=>{
    if(!state||active||state.adopting||released.current===state)return; // 採用中の版の進みは採用の完了処理に任せる
    released.current=state;setState(null);noticeRef.current(AUTO_END);
  },[state,active,setState]);
  const build=useCallback((base:TrialSwapBase,clipId:string,assetId:string,endMode:TrialEndMode):boolean=>{
    const next=generation.current+1,result=buildTrialSwap(base.document,{clipId,assetId,endMode,generation:next});
    if(!result.ok){setError({clipId,message:result.reason});return false;}
    generation.current=next;setError(null);setState({base,clipId,assetId,endMode,generation:next,result,adopting:false});return true;
  },[setState]);
  const start=useCallback((base:TrialSwapBase,clipId:string,assetId:string)=>!stateRef.current?.adopting&&build(base,clipId,assetId,'loop'),[build]);
  const choose=useCallback((assetId:string)=>{const s=stateRef.current;return !!s&&!s.adopting&&build(s.base,s.clipId,assetId,s.endMode);},[build]);
  const setEndMode=useCallback((mode:TrialEndMode)=>{const s=stateRef.current;return !!s&&!s.adopting&&build(s.base,s.clipId,s.assetId,mode);},[build]);
  const revert=useCallback(()=>{const s=stateRef.current;if(s&&!s.adopting){setError(null);setState(null);}},[setState]);
  const clearError=useCallback(()=>setError(null),[]);
  /** 最新の試し（描画を待たずに読む）。編集操作の共通入口が、古い描画の閉包からでも試し中を見分けるために使う。 */
  const readTrial=useCallback(()=>stateRef.current,[]);
  const adopt=useCallback(async():Promise<Outcome|'busy'>=>{
    const s=stateRef.current;if(!s||s.adopting)return 'busy';
    setState({...s,adopting:true});
    const outcome=await executeAt(s.result.command,{sessionId:s.base.sessionId,revision:s.base.document.revision});
    if(outcome==='failed'){if(stateRef.current)setState({...stateRef.current,adopting:false});return outcome;} // 試しは残す（理由は既存のセッションのエラー表示）
    setState(null);
    if(outcome==='unknown')await refreshRef.current?.();
    if(mountedRef.current){if(outcome==='conflict')noticeRef.current(CONFLICT);else if(outcome==='unknown')noticeRef.current(UNKNOWN);}
    return outcome;
  },[executeAt,setState]);
  return {trial,error,start,choose,setEndMode,revert,adopt,clearError,readTrial};
}
