import type { RenderState } from '../useRenderJob';

/**
 * 書き出し中の通知（高速書き出しの退避／互換経路への切替）を**在り処ごと**まとめた面。
 *
 * 置き方の設計（H-3）:
 * 以前この2つはツールバーの書き出し帯から `position:absolute` で下へ浮いていた。真下は
 * 右ドックのタブ帯（文字起こし／設定／AI）で、
 *   - 面を不透明にすると**書き出し中はタブが完全に見えなくなる**（クリックは透過しても、
 *     見えないタブは操作できない）
 *   - `pointer-events:none` にすると title ツールチップが永久に出ない
 *   - 2つ同時に立つと**同じ絶対位置に重なり**、不透明な今は片方が完全に隠れる
 * という 3 つの症状が同時に出ていた。個別に絆創膏を貼らず「置き方」を変える:
 * 通知はツールバー直下の**バナー枠（.conv-banner-slot＝グリッドの auto 行）に流し込み**、
 * 他の UI を塞がず・互いを隠さず・当たり判定を持ったまま縦に積む。
 */

/** 退避理由が分からないときの既定文言（サーバが理由を返さなかった場合）。 */
export const FAST_CUT_FALLBACK_DEFAULT_MESSAGE =
  '今回は通常の書き出しになりました（素材の形式などにより高速書き出しを使えませんでした。内容は変わりません）。';

export interface ExportNotice {
  /** React key 兼テスト用の識別子。 */
  key: 'fastcut' | 'warning';
  text: string;
  /** 見た目のトーン（info=案内・warn=注意）。 */
  tone: 'info' | 'warn';
}

/**
 * 書き出し中に出すべき通知を並べる（純関数・表示順は固定）。
 * running を離れたら何も出さない（done/error の表示はツールバー側の帯が持つ）。
 */
export function exportNotices(
  state: RenderState,
  fastCutFallbackNotice: boolean,
  fastCutFallbackMessage: string | null,
): ExportNotice[] {
  if (state.status !== 'running') return [];
  const notices: ExportNotice[] = [];
  if (fastCutFallbackNotice) {
    notices.push({
      key: 'fastcut',
      text: fastCutFallbackMessage ?? FAST_CUT_FALLBACK_DEFAULT_MESSAGE,
      tone: 'info',
    });
  }
  if (state.warning !== undefined) {
    notices.push({ key: 'warning', text: state.warning, tone: 'warn' });
  }
  return notices;
}

interface ExportNoticesProps {
  renderState: RenderState;
  fastCutFallbackNotice?: boolean;
  fastCutFallbackMessage?: string | null;
}

export function ExportNotices({
  renderState,
  fastCutFallbackNotice = false,
  fastCutFallbackMessage = null,
}: ExportNoticesProps) {
  const notices = exportNotices(renderState, fastCutFallbackNotice, fastCutFallbackMessage);
  if (notices.length === 0) return null;
  return (
    <div className="export-notices" data-testid="export-notices">
      {notices.map((n) => (
        <div
          key={n.key}
          className={`export-note export-note-${n.tone}`}
          data-notice={n.key}
          role="note"
          // 全文を折り返して出すので通常は省略されないが、狭い幅で切れた時のために残す
          // （当たり判定を持つ面なのでツールチップが実際に出る）。
          title={n.text}
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}
