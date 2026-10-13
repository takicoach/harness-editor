import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ThumbnailContent, ThumbnailLayer } from '../../../core/thumbnail/model';
import { boxStyle, textEditBox } from './canvasMath';
import { textLayerName } from './layerFactory';
import type { ThumbnailEditor } from './useThumbnailEditor';

type TextContent = Extract<ThumbnailContent, { kind: 'text' }>;
/** 文字のその場編集。描画ではそのレイヤーを隠し（hiddenLayerIds）、同じ位置に同じ書式の入力欄を重ねる。 */
export function ThumbnailTextEditor({ editor }: { editor: ThumbnailEditor }) {
  const layer = editor.editingText ? editor.page.layers.find(item => item.id === editor.editingText) : undefined;
  if (!layer || layer.content.kind !== 'text') return null;
  return <TextEditorBody key={layer.id} editor={editor} layer={layer} content={layer.content} />;
}
function TextEditorBody({ editor, layer, content }: { editor: ThumbnailEditor; layer: ThumbnailLayer; content: TextContent }) {
  const [value, setValue] = useState(content.text), area = useRef<HTMLTextAreaElement>(null), done = useRef(false);
  const latest = useRef({ editor, value });
  latest.current = { editor, value };
  const finish = useCallback(async (commit: boolean): Promise<boolean> => {
    if (done.current) return true;
    done.current = true;
    const { editor: current, value: text } = latest.current;
    current.setEditingText(null);
    if (!commit || text === content.text) return true;
    if (!text.trim()) return current.execute({ type: 'delete-layers', pageId: current.pageId, layerIds: [layer.id] });
    const rename = layer.name === textLayerName(content.text);
    return current.updateLayers([{ layerId: layer.id, patch: { content: { ...content, text }, ...(rename ? { name: textLayerName(text) } : {}) } }]);
  }, [content, layer]);
  useEffect(() => { const element = area.current; element?.focus(); element?.select(); }, []);
  // 保存・書き出し・画面を離れる前に、入力中の文字を確定させる。
  useEffect(() => latest.current.editor.registerFlush(() => finish(true)), [finish]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中の Enter（確定）と Esc（変換の取り消し）は、変換のためのもの。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void finish(true); }
  };
  const box = textEditBox(layer, editor.document.canvas, value)!, appearance = content.appearance, size = layer.visual.scale * editor.scale;
  const style: CSSProperties = { ...boxStyle(box, editor.scale), fontFamily: appearance.fontFamily, fontSize: appearance.fontSize * size, fontWeight: appearance.fontWeight,
    lineHeight: appearance.lineHeight, letterSpacing: appearance.letterSpacing * size, color: appearance.color, textAlign: appearance.align };
  return <textarea ref={area} className="native-thumbnail-text-editor" aria-label="文字の編集" value={value} maxLength={300} spellCheck={false} style={style}
    onChange={event => setValue(event.target.value)} onKeyDown={onKeyDown} onBlur={() => void finish(true)} onPointerDown={event => event.stopPropagation()} />;
}
