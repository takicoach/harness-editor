import { textLayerOf } from './layerFactory';
import type { ThumbnailEditor } from './useThumbnailEditor';

const PRESETS = [{ label: '見出しを足す', text: '見出し', size: 160 }, { label: '小見出しを足す', text: '小見出し', size: 100 }, { label: '本文を足す', text: '本文', size: 60 }] as const;
export function ThumbnailTextDrawer({ editor }: { editor: ThumbnailEditor }) {
  return <div className="native-thumbnail-drawer-list">
    {PRESETS.map(preset => <button key={preset.label} type="button" className="btn-secondary native-thumbnail-wide" disabled={editor.disabled}
      onClick={() => void editor.addLayer(textLayerOf(editor.newLayerId(), preset.text, preset.size))}>{preset.label}</button>)}
    <p className="native-thumbnail-note">文字はキャンバス上でダブルクリックすると、その場で直せます（日本語入力に対応）。</p>
  </div>;
}
