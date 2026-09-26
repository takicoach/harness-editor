import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {extractErrorMessage} from '../fetchJson';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {textComponentId} from '../../core/sequence/textStyle';

interface PlanFile {path:string;action:'add'|'modify'}
export interface TelopTemplatePlanView {
  planId:string;documentId:string;revision:number;versionLabel:string;files:PlanFile[];
  styleIds:number[];animations:string[];captionCount:number;fromAssetId:string|null;
}
interface AppliedView {planId:string;asset:SequenceAsset;fromAssetId:string|null;captionCount:number;versionLabel:string}
/** GET /api/telop-template-update/status の応答（サーバー側 TelopTemplateUpdateStatus と同形）。 */
interface AppliedStatus {planId:string;assetId:string;fromAssetId:string|null;captionCount:number;appliedAt:string}

export interface TelopTemplateUpdateProps {
  projectId:string;
  document:SequenceDocument;
  disabled:boolean;
  expectedRevision:number;
  onRegisterAsset(asset:SequenceAsset):Promise<boolean>;
  onReplaceAsset(fromAssetId:string,toAssetId:string):Promise<boolean>;
}

/** その字幕（telop）クリップの中に、指定した部品 id を参照しているものがあるか。 */
function documentReferencesAsset(document:SequenceDocument,assetId:string):boolean {
  return document.clips.some(clip=>clip.content.kind==='telop'&&textComponentId(document,clip.content)===assetId);
}

/** NativeAnimationList の「この案件の字幕で新しい動きを使えるようにする」からもこの導線を開けるようにする
 * ための最小限のハンドル（I-2e）。plan を呼ぶだけで、他は一切外から操作しない。 */
export interface TelopTemplateUpdateHandle {open():void}

/** 中止（409 等）の reason を読む。message 自体は extractErrorMessage が返すものをそのまま使い、
 * reason は revert の失敗が「再試行で直るか（applied を保つか）」の判断に使う。
 * 実体は src/server/telopTemplateUpdate.ts の union（TelopTemplatePlanReason / ApplyReason / RevertReason）。 */
function readReason(body:unknown):string|undefined {
  if(body&&typeof body==='object'&&'reason' in body&&typeof (body as {reason:unknown}).reason==='string')
    return (body as {reason:string}).reason;
  return undefined;
}

/**
 * 設計 I-2 の導線。plan → 確認 → apply → 登録（register-assets）→（任意で）参照切替
 * （replace-text-style-asset）→ 更新前に戻す（revert）。
 *
 * apply は文書に何も登録しない（.harness/components/ に保存するだけ）ので、UI 側が
 * ①register-assets → ②replace-text-style-asset の順で 2 コマンドを打つ（Task 19/20 引き継ぎ）。
 * ①を飛ばすと ②は MISSING_TARGET で失敗するため、①が失敗したら②へ進まない。
 * ただし apply が 200 を返した時点で案件のファイルは書き換わっているので、①の失敗は
 * 「案件を変えていない」ではなく「部品は更新済み・登録だけ失敗」。この状態では
 * 「もう一度登録する」と「更新前に戻す」の 2 つを出す（I-2／Codex P2）。
 *
 * 「押すまで案件に何も書かない」を守るため、最初の描画では fetch を 1 本も出さない。
 * 適用中に案件が切り替わったら結果を捨てる（このコンポーネントの中だけの世代照合。
 * ファイル側は apply が原子的に終わっているか自動復元済みなので、どちらでも矛盾は残らない）。
 *
 * 「更新前に戻す」は最新の planId だけを対象に出す。同一案件で 2 件目の plan を作ると
 * 1 件目の staging は消えるため、applied の state を常に最新 plan の結果へ差し替える。
 */
export const NativeTelopTemplateUpdate=forwardRef<TelopTemplateUpdateHandle,TelopTemplateUpdateProps>(function NativeTelopTemplateUpdate(props,ref) {
  const [plan,setPlan]=useState<TelopTemplatePlanView|null>(null);
  const [applied,setApplied]=useState<AppliedView|null>(null);
  const [switched,setSwitched]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [notice,setNotice]=useState('');
  // apply は成功したが register-assets が通っていない状態。部品は更新済み・案件には未登録。
  const [registered,setRegistered]=useState(false);
  // マウント直後、サーバーの控えから applied を復元できるか確認している間。この間は開始ボタンを
  // 出さない（ちらつき防止。復元できるのに一瞬「未適用」の画面を見せてしまうため）。
  const [statusLoading,setStatusLoading]=useState(true);
  const epoch=useRef(0);
  const lastReason=useRef<string|undefined>(undefined);
  const documentRef=useRef(props.document);documentRef.current=props.document;
  useEffect(()=>{
    epoch.current++;setPlan(null);setApplied(null);setSwitched(false);setRegistered(false);setError('');setNotice('');
    setStatusLoading(true);
    const generation=epoch.current;
    // 選択クリップが字幕以外へ移ると NativeInspector 内のこのコンポーネントはアンマウントされ、
    // ここまでの state（applied 等）は失われる。字幕を再選択したときの再マウントで、サーバー側の
    // 控え（.applied.json）から state を復元する（Codex P2）。読み取り専用、dispatch は呼ばない。
    (async()=>{
      try{
        const response=await fetch(`/api/telop-template-update/status?id=${encodeURIComponent(props.projectId)}`);
        const body:unknown=await response.json().catch(()=>null);
        if(generation!==epoch.current)return;
        const status=(body&&typeof body==='object'&&body!==null&&'applied' in body)
          ?(body as {applied:AppliedStatus|null}).applied:null;
        if(status){
          const doc=documentRef.current;
          const stillOnPrevious=status.fromAssetId!==null&&documentReferencesAsset(doc,status.fromAssetId);
          setApplied({planId:status.planId,asset:{id:status.assetId} as SequenceAsset,
            fromAssetId:status.fromAssetId,captionCount:status.captionCount,versionLabel:''});
          setRegistered(true);
          setSwitched(!stillOnPrevious);
        }
      }catch{ /* 復元は補助。失敗しても「開始ボタンから」に普通にフォールバックする。 */ }
      finally{ if(generation===epoch.current)setStatusLoading(false); }
    })();
  },[props.projectId]);

  const call=async<T,>(path:string,body:unknown):Promise<T|null>=>{
    const generation=epoch.current;
    setBusy(true);setError('');lastReason.current=undefined;
    try{
      const response=await fetch(`/api/telop-template-update/${path}?id=${encodeURIComponent(props.projectId)}`,
        {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result:unknown=await response.json().catch(()=>null);
      if(generation!==epoch.current)return null;                     // 案件が切り替わった
      if(!response.ok){
        const reason=readReason(result);
        const message=extractErrorMessage(result);
        // message には既にサーバー側の理由文が入っている。reason は revert が
        // 「開始状態へ戻すか」の判断に使うため lastReason に控えておく。
        lastReason.current=reason;
        // 「案件は変えていません」と言えるのは中止された経路だけ。plan は書き込みゼロ、apply は
        // 失敗すればバックアップから自動復元される。revert の失敗は逆に「案件は更新されたまま」
        // なので、ここで足すと事実と反対のことを断言してしまう（I-2 ③）。
        throw new Error(path==='revert'?message:`${message} 案件は変えていません。`);
      }
      return result as T;
    }catch(cause){
      if(generation===epoch.current)
        setError(cause instanceof Error?cause.message:String(cause));
      return null;
    }finally{ if(generation===epoch.current)setBusy(false); }
  };

  const start=async()=>{const result=await call<TelopTemplatePlanView>('plan',{});if(result)setPlan(result);};
  useImperativeHandle(ref,()=>({open:()=>{if(!props.disabled&&!busy&&!applied)void start();}}));
  const apply=async(target:TelopTemplatePlanView)=>{
    setPlan(null);
    const result=await call<AppliedView>('apply',{planId:target.planId,expectedRevision:props.expectedRevision});
    if(!result)return;
    // apply が 200 を返した時点で src/テロップテンプレート/ の 4 ファイルは書き換わっている。
    // 先に applied を持たせておかないと、この後の register が失敗したときに「更新前に戻す」が
    // 一度も描かれず、部品だけ新しい・案件は未登録という状態から出られなくなる（I-2／Codex P2）。
    setSwitched(false);setRegistered(false);setApplied(result);setNotice('');
    await register(result);
  };
  /** ①register-assets。result.asset には textStyleCatalog が乗っている前提（apply の応答をそのまま渡す）。 */
  const register=async(target:AppliedView)=>{
    const generation=epoch.current;
    setBusy(true);setError('');
    try{
      const ok=await props.onRegisterAsset(target.asset);
      if(generation!==epoch.current)return;
      if(!ok){
        setNotice('');
        // 事実を書く。部品は更新済みで、案件への登録だけが失敗している。
        setError('部品は更新済みですが、案件への登録に失敗しました。もう一度登録するか、更新前に戻してください。');
        return;
      }
      setRegistered(true);setNotice('部品を更新しました。');
    }finally{ if(generation===epoch.current)setBusy(false); }
  };
  const replace=async(target:AppliedView)=>{
    if(!target.fromAssetId)return;
    // ②replace-text-style-asset。①（register-assets）の後にしか呼ばれない導線（次で開くボタン経由）。
    if(await props.onReplaceAsset(target.fromAssetId,target.asset.id)){
      setSwitched(true);setNotice(`字幕 ${target.captionCount}件を新しい部品に切り替えました。元に戻すは 1 回で効きます。`);
    }
  };
  const revert=async(target:AppliedView)=>{
    const result=await call<{restored:string[];stillReferenced:boolean;notice:string}>('revert',{planId:target.planId});
    if(!result){
      // 再試行しても直らない reason（控えが無い／plan が既に失効）の時だけ、apply 失敗時と対称に
      // 初期状態（再 plan の導線）へ戻す。それ以外（ネットワーク等の一時的な失敗）は applied を保ち、
      // 「更新前に戻す」で再試行できるままにする。
      const reason=lastReason.current;
      if(reason==='backup-missing'||reason==='plan-not-found'){
        setApplied(null);setSwitched(false);setRegistered(false);
        setError(current=>`${current} もう一度確認からやり直してください。`);
      }
      return;
    }
    setApplied(null);setSwitched(false);setRegistered(false);
    // stillReferenced（新資産をまだ参照している字幕がある）の案内はサーバーの notice にそのまま入っている。
    setNotice(result.notice);
  };

  const added=plan?.files.filter(file=>file.action==='add').length??0;
  return <div className="native-telop-template-update">
    {!applied&&!statusLoading&&<button type="button" className="native-text-button" disabled={props.disabled||busy}
      onClick={()=>void start()}>この案件の字幕で新しい動きを使えるようにする</button>}
    {(busy||statusLoading)&&<p className="native-subtle">確認しています…</p>}
    {error&&<p role="alert">{error}</p>}
    {notice&&!error&&<p role="status" className="native-subtle">{notice}</p>}
    {plan&&<div role="alertdialog" aria-label="テロップ部品の更新の確認" className="native-style-confirm">
      <p>{plan.versionLabel}を更新します。</p>
      <ul>
        <li>{plan.files.length}つのファイルを変更します（うち{added}つは新規追加）。</li>
        <li>スタイルの数（{plan.styleIds.length}件）は変わりません。いまの見た目もそのままです。</li>
        <li>新しく使える動きは全{plan.animations.length}種になります。</li>
        <li>この案件の字幕 {plan.captionCount}件は、切り替えるまで今までの部品のまま描きます。</li>
      </ul>
      <button type="button" onClick={()=>void apply(plan)}>更新する</button>
      <button type="button" onClick={()=>setPlan(null)}>やめる</button>
    </div>}
    {applied&&<div className="native-telop-template-applied">
      {!registered&&<button type="button" className="native-text-button" disabled={props.disabled||busy}
        onClick={()=>void register(applied)}>もう一度登録する</button>}
      {registered&&!switched&&applied.fromAssetId&&<button type="button" className="native-text-button" disabled={props.disabled||busy}
        onClick={()=>void replace(applied)}>いまの字幕 {applied.captionCount}件を新しい部品に切り替える</button>}
      <button type="button" className="native-text-button" disabled={props.disabled||busy}
        onClick={()=>void revert(applied)}>更新前に戻す</button>
    </div>}
  </div>;
});
