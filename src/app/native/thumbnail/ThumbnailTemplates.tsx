import { CaptureFrameProvider } from '../../../captureRuntime';
import { THUMBNAIL_TEXT_STYLES, thumbnailTextAppearance, type ThumbnailTextStyle } from '../../../core/thumbnail/textStyles';
import { NativeText } from '../../../preview/native/NativeText';
import { isEditable } from './layerActions';
import { textLayerOf } from './layerFactory';
import type { ThumbnailEditor } from './useThumbnailEditor';

const SAMPLE = { width: 640, height: 240 };
/** 「サムネの定番」の文字スタイル。選んだ文字（ロック中を除く）に当て、無ければ新しい見出しとして足す。 */
export function ThumbnailTemplates({ editor }: { editor: ThumbnailEditor }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  const target = layer && layer.content.kind === 'text' && isEditable(layer) ? layer : undefined;
  const apply = (style: ThumbnailTextStyle) => {
    if (target && target.content.kind === 'text') {
      void editor.updateLayers([{ layerId: target.id, patch: { content: { ...target.content, appearance: style.apply(target.content.appearance) } } }]);
      return;
    }
    const added = textLayerOf(editor.newLayerId(), '見出し', 160);
    if (added.content.kind === 'text') void editor.addLayer({ ...added, content: { ...added.content, appearance: style.apply(added.content.appearance) } });
  };
  return <div className="native-thumbnail-drawer-list">
    <p className="native-thumbnail-note">{target ? `「${target.name}」に当てます` : '新しい見出しとして足します（文字を選んでいると、その文字に当てます）'}</p>
    <div className="native-thumbnail-templates">
      {THUMBNAIL_TEXT_STYLES.map(style => <button key={style.id} type="button" className="btn-secondary native-thumbnail-template" aria-label={style.name} title={style.name}
        disabled={editor.disabled} onClick={() => apply(style)}>
        <span className="native-thumbnail-template-sample" aria-hidden="true">
          <span className="native-thumbnail-template-paper" style={{ width: SAMPLE.width, height: SAMPLE.height }}>
            <CaptureFrameProvider frame={0} videoConfig={{ width: SAMPLE.width, height: SAMPLE.height, fps: 30, durationInFrames: 1 }}>
              <NativeText segment={{ id: 0, startFrame: 0, endFrame: 1, text: 'サムネ', animation: 'none' }} appearance={style.apply(thumbnailTextAppearance(120))} />
            </CaptureFrameProvider>
          </span>
        </span>
        <span className="native-thumbnail-template-name">{style.name}</span>
      </button>)}
    </div>
  </div>;
}
