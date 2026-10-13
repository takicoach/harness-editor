import { useEffect, useRef, useState } from 'react';
import type { SequenceAsset } from '../../../core/sequence/model';
import { formatFrameTime, frameCountOf, frameTime, sourceTimeOf, streamFps } from './framePick';
import { frameLayerOf } from './layerFactory';
import { sequenceAssetUrl } from './thumbnailApi';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 見本の読み元。原本 → 再生できなければ動画側と同じ軽量版（preview=1。無ければサーバーは原本を返す）→ それも駄目なら案内。 */
type PreviewSource = 'original' | 'proxy' | 'failed';
/** 動画から 1 コマを選ぶ。見本は <video> の表示で、サムネには原本のそのコマ（原寸）が入る（軽量版で見ていても、選んだ時刻は原本の秒）。 */
export function ThumbnailFramePicker({ editor, asset, ensure, onClose }: { editor: ThumbnailEditor; asset: SequenceAsset; ensure(asset: SequenceAsset): Promise<boolean>; onClose(): void }) {
  const stream = asset.streams.find(item => item.kind === 'video')!, fps = streamFps(stream), count = frameCountOf(stream);
  const [frame, setFrame] = useState(0), [busy, setBusy] = useState(false), [source, setSource] = useState<PreviewSource>('original'), video = useRef<HTMLVideoElement>(null);
  const original = sequenceAssetUrl(editor.projectId, asset.id), src = source === 'original' ? original : `${original}&preview=1`;
  useEffect(() => { if (video.current && video.current.readyState >= 1) video.current.currentTime = frameTime(frame, fps); }, [frame, fps]);
  const go = (next: number) => setFrame(Math.max(0, Math.min(count - 1, next)));
  const place = async () => {
    setBusy(true);
    try { if (await ensure(asset) && await editor.addLayer(frameLayerOf(editor.newLayerId(), asset, stream.index, sourceTimeOf(frame, fps)), 0)) onClose(); }
    finally { setBusy(false); }
  };
  return <div className="native-thumbnail-frame-picker" role="group" aria-label={`${asset.name}のコマを選ぶ`}>
    <video ref={video} className="native-thumbnail-frame-video" src={src} muted playsInline preload="auto"
      onLoadedMetadata={event => { event.currentTarget.currentTime = frameTime(frame, fps); }}
      onError={() => setSource(current => current === 'original' ? 'proxy' : 'failed')} />
    {source === 'failed' && <p className="native-thumbnail-note" role="status">
      この動画はここでは再生できません。動画の編集画面で「軽量化する」を押して軽量版を作ると、ここでコマを選べます（サムネには元の動画のコマが入ります）。</p>}
    <input type="range" aria-label="コマの位置" min={0} max={count - 1} step={1} value={frame} onChange={event => go(Number(event.target.value))} />
    <div className="native-thumbnail-row">
      <button type="button" className="btn-ghost native-header-icon" aria-label="前のコマ" title="前のコマ" disabled={frame === 0} onClick={() => go(frame - 1)}>◀</button>
      <output className="native-thumbnail-size" aria-label="選んでいるコマの時刻">{formatFrameTime(frame, fps)}</output>
      <button type="button" className="btn-ghost native-header-icon" aria-label="次のコマ" title="次のコマ" disabled={frame >= count - 1} onClick={() => go(frame + 1)}>▶</button>
    </div>
    <p className="native-thumbnail-note">{source === 'proxy' ? '元の動画はここでは再生できないため、軽量版で表示しています。' : '表示は目安です。'}サムネには元の動画のこのコマが原寸で入ります。</p>
    <div className="native-thumbnail-row">
      <button type="button" className="btn-primary" disabled={editor.disabled || busy || source === 'failed'} onClick={() => void place()}>このコマを背景にする</button>
      <button type="button" className="btn-ghost" onClick={onClose}>戻る</button>
    </div>
  </div>;
}
