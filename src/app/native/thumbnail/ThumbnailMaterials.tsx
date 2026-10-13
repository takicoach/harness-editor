import { useState } from 'react';
import type { SequenceAsset, SequenceDocument } from '../../../core/sequence/model';
import type { ThumbnailShapeKind } from '../../../core/thumbnail/model';
import { imageLayerOf, shapeLayerOf } from './layerFactory';
import { sequenceAssetUrl } from './thumbnailApi';
import { ThumbnailFramePicker } from './ThumbnailFramePicker';
import type { ThumbnailEditor } from './useThumbnailEditor';

const SHAPES: ReadonlyArray<{ kind: ThumbnailShapeKind; label: string }> = [
  { kind: 'rect', label: '四角を足す' }, { kind: 'ellipse', label: '丸を足す' }, { kind: 'arrow', label: '矢印を足す' }, { kind: 'line', label: '線を足す' }];

/** 図形と、案件（動画側）の画像・動画。動画は「コマを選ぶ」へ進む。 */
export function ThumbnailMaterials({ editor, videoDocument }: { editor: ThumbnailEditor; videoDocument: SequenceDocument }) {
  const [picking, setPicking] = useState<SequenceAsset | null>(null);
  const images = videoDocument.assets.filter(asset => asset.kind === 'image');
  const videos = videoDocument.assets.filter(asset => asset.kind === 'media' && asset.streams.some(stream => stream.kind === 'video'));
  // サムネの文書に無い素材は先に登録する（登録も 1 回の操作として記録される）。
  const ensure = async (asset: SequenceAsset) => editor.document.assets.some(item => item.id === asset.id) || await editor.session.registerAssets([asset.id]);
  const placeImage = async (asset: SequenceAsset, role: 'photo' | 'element') => {
    if (await ensure(asset)) await editor.addLayer(imageLayerOf(editor.newLayerId(), asset.name, asset.id, role), role === 'photo' ? 0 : undefined);
  };
  if (picking) return <ThumbnailFramePicker editor={editor} asset={picking} ensure={ensure} onClose={() => setPicking(null)} />;
  return <div className="native-thumbnail-drawer-list">
    <h3 className="native-thumbnail-subhead">図形</h3>
    <div className="native-thumbnail-grid">
      {SHAPES.map(item => <button key={item.kind} type="button" className="btn-secondary" disabled={editor.disabled}
        onClick={() => void editor.addLayer(shapeLayerOf(editor.newLayerId(), item.kind))}>{item.label}</button>)}
    </div>
    <h3 className="native-thumbnail-subhead">案件の画像</h3>
    {images.length ? images.map(asset => <div key={asset.id} className="native-thumbnail-asset">
      <img src={sequenceAssetUrl(editor.projectId, asset.id)} alt="" loading="lazy" />
      <span className="native-thumbnail-asset-name">{asset.name}</span>
      <button type="button" className="btn-ghost" aria-label={`${asset.name}を背景にする`} disabled={editor.disabled} onClick={() => void placeImage(asset, 'photo')}>背景にする</button>
      <button type="button" className="btn-ghost" aria-label={`${asset.name}を素材として置く`} disabled={editor.disabled} onClick={() => void placeImage(asset, 'element')}>素材として置く</button>
    </div>) : <p className="native-thumbnail-note">案件に画像はありません。「取り込み」から足せます。</p>}
    <h3 className="native-thumbnail-subhead">案件の動画</h3>
    {videos.length ? videos.map(asset => <div key={asset.id} className="native-thumbnail-asset">
      <span className="native-thumbnail-asset-name">{asset.name}</span>
      <button type="button" className="btn-tonal" aria-label={`${asset.name}のコマを選ぶ`} disabled={editor.disabled} onClick={() => setPicking(asset)}>コマを選ぶ</button>
    </div>) : <p className="native-thumbnail-note">案件に動画はありません。</p>}
  </div>;
}
