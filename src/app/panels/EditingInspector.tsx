import type { EditState } from '../edit/editState';
import { cutOrderingOf } from '../../core/cutOrder';
import { moveCutSegment } from '../edit/cutOrderOps';
import { deleteMainClip, mainClipDeleteBlockedReason } from '../edit/mainClipOps';
import { setTelopTiming } from '../edit/telopSettingsOps';
import { retimeImage } from '../edit/imageOps';
import { retimeVideoInsert } from '../edit/videoInsertOps';
import { resizeBgm } from '../edit/bgmOps';
import { resizeSe } from '../edit/seOps';
import { retimeShape } from '../edit/shapeOps';
import { setTitleTiming } from '../edit/titleOps';
import { setTelopText } from '../edit/textOps';
import { FrameRangeFields } from './FrameRangeFields';
import type { PlaybackModel } from '../../preview/playbackModel';
import { ASSET_KEYS, assetFinalRange, placeAsset, type AssetKind } from '../edit/assetPlacementOps';

/** Editing controls concern clip order and source timing; finishing retains appearance/audio. */
export function EditingInspector({ state, fps, model, onEdit, onFinish, onFinishAudio }: {
  state: EditState; fps: number; onEdit: (op: (state: EditState) => EditState) => void; onFinish: () => void;
  model?: PlaybackModel;
  onFinishAudio?: () => void;
}) {
  const selection = state.selection;
  const segments = cutOrderingOf(state).segments;
  const clip = selection?.kind === 'cutSegment' ? segments.find(s => s.id === selection.id) : undefined;
  const kind = selection?.kind;
  const id = selection && 'id' in selection ? selection.id : -1;
  const items = kind === 'telop' ? state.telops : kind === 'image' ? state.images : kind === 'videoInsert' ? state.videoInserts : kind === 'bgm' ? state.bgm : kind === 'se' ? state.se : kind === 'title' ? state.titles : kind === 'shape' ? state.shapes : [];
  const item = items.find(item => item.id === id);
  const labels = { telop: '字幕 / テロップ', image: '画像', videoInsert: 'サブ動画', bgm: 'BGM', se: '効果音', title: 'タイトル', shape: '図形', cutSegment: '映像 / 元音声', mainVideo: '映像', join: 'つなぎ目' };
  const target = clip ?? item;
  const finalRange = model && kind && kind in ASSET_KEYS ? assetFinalRange(model, kind as AssetKind, id) : null;
  const range = finalRange ?? (target ? { start: target.originalStart, end: target.originalEnd } : null);
  function retime(start: number, end: number): void {
    if (model && finalRange && kind && kind in ASSET_KEYS) {
      onEdit(prev => placeAsset(prev, model, kind as AssetKind, id, start, end)); return;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || end > (state.originalTotalFrames ?? Infinity)) return;
    const operations = { telop: setTelopTiming, image: retimeImage, videoInsert: retimeVideoInsert, bgm: resizeBgm, se: resizeSe, title: setTitleTiming, shape: retimeShape };
    if (kind && kind in operations) {
      const operation = operations[kind as keyof typeof operations];
      onEdit(prev => operation(prev, id, start, end));
    }
  }
  return <section className="editing-inspector" data-testid="editing-inspector" aria-label="編集のクリップ設定">
    <header><span className="editing-eyebrow">CLIP</span><h2>{kind ? labels[kind] : 'クリップを選択'}</h2></header>
    {onFinishAudio && (!kind || kind === 'cutSegment' || kind === 'mainVideo') &&
      <button className="editing-finish-link" onClick={onFinishAudio}>元音声の音量・ミュートを調整 →</button>}
    {target ? <>
      <p className="editing-clip-name">{item && 'file' in item ? item.file.split('/').at(-1) : clip ? `映像 ${segments.indexOf(clip) + 1}` : item && 'text' in item ? item.text : `#${id}`}</p>
      <dl><dt>{finalRange ? '表示する長さ' : '長さ（原素材）'}</dt><dd>{((range!.end - range!.start) / fps).toFixed(2)} 秒</dd></dl>
      <FrameRangeFields key={`${kind}:${id}:${!!finalRange}`}
        start={range!.start} end={range!.end} fps={fps} clock={finalRange ? 'final' : 'source'}
        max={finalRange ? model!.durationInFrames : state.originalTotalFrames ?? target.originalEnd} readOnly={!!clip} onCommit={retime} />
      {kind === 'telop' && item && 'text' in item && <label className="editing-text-field">本文<textarea key={`${id}:${item.text}`} defaultValue={item.text}
        onBlur={event => { const text = event.currentTarget.value; if (text !== item.text) onEdit(prev => setTelopText(prev, id, text)); }} /></label>}
      {clip && <>
        <div className="editing-actions">
          <button disabled={segments.indexOf(clip) === 0} onClick={() => onEdit(prev => moveCutSegment(prev, clip.id, segments.indexOf(clip) - 1))}>前へ移動</button>
          <button disabled={segments.indexOf(clip) === segments.length - 1} onClick={() => onEdit(prev => moveCutSegment(prev, clip.id, segments.indexOf(clip) + 1))}>後ろへ移動</button>
        </div>
        <button className="editing-delete" disabled={!!mainClipDeleteBlockedReason(state, clip.id)} title={mainClipDeleteBlockedReason(state, clip.id) ?? '後続を詰めて削除'} onClick={() => onEdit(prev => deleteMainClip(prev, clip.id))}>クリップを詰め削除 · Delete</button>
      </>}
    </> : <p>タイムラインの映像・音声・素材を選ぶと、ここに編集項目が表示されます。</p>}
    <div className="editing-help"><p><kbd>C</kbd> でレーザーに切り替え、映像・元音声をクリックして分割。<kbd>V</kbd> で選択に戻り、<kbd>Delete</kbd> で詰め削除します。</p><p>再生ヘッド位置での分割は <kbd>⌘/Ctrl + K</kbd> または <kbd>B</kbd>。ドラッグで並び替え、「なぞってカット」で範囲を選んで削除できます。</p></div>
    <button className="editing-finish-link" onClick={onFinish}>位置・色・音を仕上げで調整 →</button>
  </section>;
}
