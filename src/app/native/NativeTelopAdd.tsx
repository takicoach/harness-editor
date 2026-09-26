import {useState} from 'react';
import {NativeFolderPicker} from './NativeFolderPicker';
import {extractErrorMessage} from '../fetchJson';
import type {SequenceAsset} from '../../core/sequence/model';

interface Props {projectId:string;disabled:boolean;onRegister(asset:SequenceAsset):Promise<boolean>}
/** 下見（/api/telop-add/inspect）の結果。この段階では案件に何も書かれていない。 */
type Preview={dir:string;packId:string;version:string;kind:'pack'|'template';ids:number[];names:string[];conflicts:number[]};

/**
 * 設計 D の 3 段（下見 → 確認 → 取り込み）をそのまま画面にする。
 *
 * 以前は取り込み（コピー・コンパイル・凍結保存）まで済ませてから確認を出しており、
 * 「やめる」を押しても .sme/telop-packs のフォルダと凍結資産が残っていた（I-1）。
 * いまは「一覧に加える」を押すまで書き込みが一切起きない。
 */
export function NativeTelopAdd({projectId,disabled,onRegister}:Props) {
  const [picking,setPicking]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  // ピッカーのポータル先（.native-workspace）を探す起点。callback ref で持つのは、
  // 文書取得後にマウントされても取り逃さないため（NativeWorkspace の shell 観測と同じ作法）。
  const [host,setHost]=useState<HTMLDivElement|null>(null);
  const call=async<T,>(path:string,dir:string):Promise<T>=>{
    const response=await fetch(`${path}?id=${encodeURIComponent(projectId)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir})});
    const body:unknown=await response.json().catch(()=>null);
    if(!response.ok)throw new Error(extractErrorMessage(body));
    return body as T;
  };
  const inspect=async(dir:string)=>{
    setPicking(false);setBusy(true);setError('');
    try{setPreview({dir,...await call<Omit<Preview,'dir'>>('/api/telop-add/inspect',dir)});}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  const add=async(target:Preview)=>{
    setPreview(null);setBusy(true);setError('');
    try{
      const result=await call<{asset:SequenceAsset}>('/api/telop-add',target.dir);
      await onRegister(result.asset);
    }
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  return <div className="native-telop-add" ref={setHost}>
    <button type="button" className="native-text-button" disabled={disabled||busy} onClick={()=>setPicking(true)}>テロップを追加</button>
    {busy&&<p className="native-subtle">フォルダを確認しています…</p>}
    {error&&<p role="alert">{error}</p>}
    {picking&&<NativeFolderPicker disabled={disabled} title="テロップのフォルダを選ぶ" note="zip を展開したフォルダを選んでください。中の telopStyles… か manifest.ts を読み取ります。"
      anchor={host} onPick={dir=>void inspect(dir)} onCancel={()=>setPicking(false)}/>}
    {preview&&<div role="alertdialog" aria-label="取り込み内容の確認" className="native-style-confirm">
      {preview.conflicts.length
        ? <>
            <p>{preview.packId}（版 {preview.version}）の番号 {preview.conflicts.join('、')} は、この案件に既にあります。取り込みは行いません。別のパックを選ぶか、先に古いパックを外してください。</p>
            <button type="button" onClick={()=>setPreview(null)}>閉じる</button>
          </>
        : <>
            <p>{preview.packId}（版 {preview.version}）から {preview.ids.length}件のスタイルを取り込みます。番号 {preview.ids.join('、')}。一覧に加えますか。</p>
            <button type="button" onClick={()=>void add(preview)}>一覧に加える</button>
            <button type="button" onClick={()=>setPreview(null)}>やめる</button>
          </>}
    </div>}
  </div>;
}
