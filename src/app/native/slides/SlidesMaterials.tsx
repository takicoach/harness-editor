import { SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import { resolveSlideTheme } from '../../../core/slides/themes';
import type { ThumbnailShapeKind } from '../../../core/thumbnail/model';
import { imageLayerOf } from '../thumbnail/layerFactory';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import type { SlidesDrawerContext } from './SlidesDrawer';
import { slidesAssetUrl } from './slidesApi';
import { slidesShapeLayer } from './slidesLayerFactory';

const SHAPES: ReadonlyArray<{ kind: ThumbnailShapeKind; label: string }> = [
  { kind: 'rect', label: '四角を足す' }, { kind: 'ellipse', label: '丸を足す' }, { kind: 'arrow', label: '矢印を足す' }, { kind: 'line', label: '線を足す' }];
/** 図形（テーマの強調色）と、このスライドに取り込んだ画像。画像は画像枠があれば枠へ、無ければ挿絵として置く。 */
export function SlidesMaterials({ editor, context }: { editor: ThumbnailEditor; context: SlidesDrawerContext }) {
  const theme = resolveSlideTheme(context.document.theme), images = context.document.assets.filter(asset => asset.kind === 'image');
  const page = context.document.pages.find(item => item.id === context.pageId), slot = page ? SLIDE_LAYOUTS[page.layout].imageSlots[0] : undefined;
  const place = (assetId: string, name: string) => page && slot
    ? void context.session.execute({ type: 'fill-image-slot', pageId: page.id, slot, assetId })
    : void editor.addLayer(imageLayerOf(editor.newLayerId(), name, assetId, 'element'));
  return <div className="native-thumbnail-drawer-list">
    <h3 className="native-thumbnail-subhead">図形</h3>
    <div className="native-thumbnail-grid">
      {SHAPES.map(item => <button key={item.kind} type="button" className="btn-secondary" disabled={editor.disabled}
        onClick={() => void editor.addLayer(slidesShapeLayer(editor.newLayerId(), item.kind, theme))}>{item.label}</button>)}
    </div>
    <h3 className="native-thumbnail-subhead">このスライドの画像</h3>
    {images.length ? images.map(asset => <div key={asset.id} className="native-thumbnail-asset">
      <img src={slidesAssetUrl(context.projectId, asset.id)} alt="" loading="lazy" />
      <span className="native-thumbnail-asset-name">{asset.name}</span>
      <button type="button" className="btn-ghost" aria-label={`${asset.name}を${slot ? '画像枠に入れる' : '置く'}`} disabled={editor.disabled} onClick={() => place(asset.id, asset.name)}>{slot ? '画像枠に入れる' : '置く'}</button>
    </div>) : <p className="native-thumbnail-note">まだ画像はありません。「取り込み」から足せます。</p>}
  </div>;
}
