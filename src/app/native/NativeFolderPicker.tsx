import {useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {browseFolder,type BrowseListing} from '../browseApi';
import {TaskProgress} from '../components/TaskProgress';
import {useDialogEscape} from '../useDialogEscape';

/**
 * 全画面の選択ダイアログ（`.native-style-overlay` は position:fixed）。
 *
 * I-1: 呼び出し元（NativeTelopAdd）は `.native-inspector-host` の子孫で、その要素は
 * `container-type:inline-size` を持つ = fixed の包含ブロックになる。木のまま描くと
 * 右カラムの箱に閉じ込められて overflow:auto に切られるので、ワークスペース要素へ
 * ポータルする。`document.body` ではなく `.native-workspace` にするのは、fieldset の
 * 無効化・下書き確定の捕捉ハンドラ・操作音の内側に置くため（I-3 と同じ理由）。
 * `.native-workspace` は transform/contain/filter/perspective を持たないので fixed の
 * 基準にはならない（2026-09-22 に getComputedStyle で実測）。
 */
/**
 * M-1': `disabled` は呼び出し元から素通しで受ける。ポータルで `<fieldset disabled>` の外に出るので、
 * AI 作業中（externalBusy）でもダイアログのボタンだけが押せる穴が開く（I-3 と同型）。
 * I-2: ただし「閉じる」は副作用のない導線なので、disabled でも常に押せるようにする
 * （フォルダ探索中・AI 作業中に閉じられなくなるのを避ける）。Escape でも同様に閉じられるよう
 * useDialogEscape（IME ガード済み）を通す。
 */
export function NativeFolderPicker({title,note,anchor,disabled,onPick,onCancel}:{title:string;note:string;anchor?:HTMLElement|null;disabled?:boolean;onPick(path:string):void;onCancel():void}) {
  const [listing,setListing]=useState<BrowseListing|null>(null),[error,setError]=useState('');
  const [path,setPath]=useState<string|undefined>(undefined);
  useDialogEscape(onCancel);
  useEffect(()=>{
    let live=true;setListing(null);setError('');
    void browseFolder(path).then(value=>{if(live)setListing(value);},cause=>{if(live)setError(cause instanceof Error?cause.message:String(cause));});
    return()=>{live=false;};
  },[path]);
  return createPortal(<div className="native-style-overlay"><div className="native-style-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header><div><h2>{title}</h2><p>{note}</p></div><button onClick={onCancel} aria-label="フォルダ選択を閉じる">閉じる</button></header>
    {error&&<p role="alert">{error}</p>}
    {!listing&&!error&&<TaskProgress compact label="フォルダを読み込んでいます"/>}
    {listing&&<>
      <div className="native-folder-path">{listing.path??'起点を選んでください'}</div>
      <div className="native-folder-list">
        {listing.parent&&<button disabled={disabled} onClick={()=>setPath(listing.parent!)}>‹ 上へ</button>}
        {listing.path===null&&listing.roots.map(root=><button key={root.key} disabled={disabled} onClick={()=>setPath(root.path)}>{root.label}</button>)}
        {listing.dirs.map(entry=><button key={entry.path} disabled={disabled} onClick={()=>setPath(entry.path)}>{entry.name}</button>)}
      </div>
      <button className="btn-primary" disabled={disabled||!listing.path} onClick={()=>onPick(listing.path!)}>このフォルダを選ぶ</button>
    </>}
  </div></div>,anchor?.closest('.native-workspace')??window.document.body);
}
