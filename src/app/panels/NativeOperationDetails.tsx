import type {NativeEditorEdit} from '../../shared/nativeEditorCommands';
import type {NativeEditorReconciliation} from '../../shared/nativeEditorEvidence';

const labels:Record<string,string>={'ripple-delete':'不要な区間をカット','restore-cut':'カットした区間を戻す','resize-cut-boundary':'カット境界を微調整',
  move:'素材の位置を移動',trim:'素材の表示タイミングを調整',split:'素材を分割',delete:'素材を削除',unlink:'映像と音声の連動を解除',
  'fill-cut-captions':'カット区間の字幕を補完','split-caption':'字幕を分割','merge-captions':'字幕を結合','set-caption-text':'字幕の本文を修正','insert-caption':'字幕を追加',
  'insert-media':'素材を追加','update-clip-visual':'映像の表示を調整','update-clip-audio':'音声を調整',
  'add-track':'トラックを追加','remove-track':'空のトラックを削除','move-track':'トラックの順番を変更','set-track-enabled':'トラックの表示・再生を変更'};
export function NativeOperationDetails({edit}:{edit:NativeEditorEdit}){
  return <details><summary>タイムラインの変更案（{edit.commands.length}件）</summary><ol>{edit.commands.map((command,index)=><li key={index}>
    {labels[command.type]??'タイムラインを調整'}
    {'startFrame' in command&&'endFrame' in command?`（${command.startFrame}〜${command.endFrame}フレーム）`:null}
    {'text' in command&&typeof command.text==='string'?`：${command.text}`:null}
  </li>)}</ol></details>;
}
export function NativeSavedStateReview({inspection}:{inspection:NativeEditorReconciliation}){
  return <p>画面と保存済みのタイムラインが一致することを確認しました。{
    inspection.savedState==='proposal'?'保存内容は、このAI編集案を適用した状態と一致しています。':
    inspection.savedState==='input'?'保存内容は、このAI編集を始める前の状態と一致しています。':
    '保存内容は、このAI編集の前後のどちらとも異なります。プレビューとタイムラインで現在の編集を確認してください。'}</p>;
}
