import { useEffect, useId, useRef, useState } from 'react';
import { TEXT_GAUGE_PERMILLE, textGaugeLabel, textSizeGauge } from '../../../core/thumbnail/textGauge';
import { Icon } from '../../Icon';
import type { StageReserve } from './canvasMath';
import type { ThumbnailEditor } from './useThumbnailEditor';
import type { ThumbnailPreviewImages } from './useThumbnailPreviews';

const CLOSED_KEY = 'sme-thumbnail-phone-closed';
/** 小窓は表示領域の右下から INSET 離して置き、キャンバスとはさらに GAP あける。 */
const PHONE_INSET = 12, PHONE_GAP = 12;
export function readPhoneOpen(): boolean { try { return localStorage.getItem(CLOSED_KEY) !== '1'; } catch { return true; } }
export function writePhoneOpen(open: boolean): void {
  try { if (open) localStorage.removeItem(CLOSED_KEY); else localStorage.setItem(CLOSED_KEY, '1'); } catch { /* 覚えられなくても表示は続ける */ }
}
/** 右下の小窓「スマホでの見え方」（見本と同じ幅 186px）。縮小画像はサーバーで撮った本物（操作が止まってから更新）、目安は今の画面の内容から即時に出す。
 *  目安は見出しの右に短く出し、説明は目安を押して広げた時（とツールチップ）に出す。占める広さは onSize で知らせ、キャンバスはその分を空ける。 */
export function ThumbnailPhonePreview({ editor, previews, onClose, onSize }: {
  editor: ThumbnailEditor; previews: ThumbnailPreviewImages; onClose(): void; onSize(reserve: StageReserve | null): void;
}) {
  const [details, setDetails] = useState(false), box = useRef<HTMLElement>(null), detailsId = useId();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const report = () => { const rect = element.getBoundingClientRect(); onSize({ width: rect.width + PHONE_INSET + PHONE_GAP, height: rect.height + PHONE_INSET + PHONE_GAP }); };
    report();
    if (typeof ResizeObserver === 'undefined') return () => onSize(null);
    const observer = new ResizeObserver(report);
    observer.observe(element, { box: 'border-box' });
    return () => { observer.disconnect(); onSize(null); };
  }, [onSize]);
  const gauge = textSizeGauge(editor.previewDocument, editor.pageId), label = textGaugeLabel(gauge), url = previews.url(editor.pageId), { canvas } = editor.document;
  const size = { aspectRatio: `${canvas.width} / ${canvas.height}`, width: canvas.width >= canvas.height ? 170 : 96 };
  const explanation = `${gauge.kind === 'none' ? 'キャンバスの中に見えている文字がありません。' : `いちばん大きい文字がキャンバスの高さの ${Math.round(gauge.ratio * 100)}%。`}`
    + `高さの ${TEXT_GAUGE_PERMILLE / 10}% 以上で「大きい」。色の差などの読みやすさは目で確かめてください。`;
  return <section ref={box} className="native-thumbnail-phone" aria-label="スマホでの見え方" style={{ right: PHONE_INSET, bottom: PHONE_INSET }}>
    <header className="native-thumbnail-phone-head"><strong>スマホでの見え方</strong>
      <button type="button" className="btn-ghost native-thumbnail-gauge" data-gauge={gauge.kind} aria-label={`文字の大きさの目安: ${label}`}
        aria-expanded={details} aria-controls={details ? detailsId : undefined} title={explanation} onClick={() => setDetails(!details)}>{label}</button>
      <button type="button" className="btn-ghost native-thumbnail-phone-close" aria-label="スマホでの見え方を閉じる" title="閉じる" onClick={onClose}><Icon name="x" size={14} /></button></header>
    {url ? <img className="native-thumbnail-phone-image" src={url} alt="スマホの一覧に並んだときの大きさの見本" style={size} />
      : <span className="native-thumbnail-phone-image" aria-hidden="true" style={size} />}
    {details && <p id={detailsId} className="native-thumbnail-note">{explanation}</p>}
  </section>;
}
