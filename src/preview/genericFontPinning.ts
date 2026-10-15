/**
 * 総称フォント（sans-serif 等）を同梱の具体名へ固定する。
 *
 * Chromium は `font-family: sans-serif` を OS のどのフォントで描くかを**プロセスごとに**決め、同じ Mac でも
 * 「Helvetica-Bold ＋ Hiragino Sans W7」と「Hiragino Kaku Gothic ProN W6」に分かれることがある（2026-10-15 実測・
 * `scripts/diag-generic-font.ts`）。書き出しはワーカーごとに別の Chromium なので、総称フォントのまま描くと
 * ブロック境界で字の太さが変わる動画になる。プレビューと書き出しの両方で、描いた要素の先頭が総称なら
 * fonts.css に同梱した Noto Sans JP / Noto Serif JP を前に置き、どの OS・どのプロセスでも同じ字形にする。
 *
 * 先頭が具体名（Noto・Arial・Hiragino など）の指定は触らない。旧既定 `"Noto Sans JP", sans-serif` の
 * fallback 補正は legacyCaptionFont.ts が別に担う。monospace・cursive 等は同梱の対応物が無いのでそのまま。
 * 戻し方は legacyCaptionFont と同じ: 自分が書いた値のまま残っている要素だけ元に戻す。
 */
type StyledElement = HTMLElement | SVGElement;

/** 総称 → 同梱フォント。キーは小文字。 */
export const GENERIC_FONT_PINS: Readonly<Record<string, string>> = {
  'sans-serif': 'Noto Sans JP', 'system-ui': 'Noto Sans JP', 'ui-sans-serif': 'Noto Sans JP', 'ui-rounded': 'Noto Sans JP',
  'serif': 'Noto Serif JP', 'ui-serif': 'Noto Serif JP', 'fangsong': 'Noto Serif JP',
};

/** font-family の先頭の family 名（引用符を外し小文字に）。空なら undefined。 */
export function firstFontFamily(list: string): string | undefined {
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/.exec(list);
  const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return name ? name.toLowerCase() : undefined;
}

/** root は要素か、描画面の ShadowRoot。ShadowRoot 自身は style を持たないので候補に入らない。 */
export function pinGenericFonts(root: Element | ShadowRoot): () => void {
  const doc = root.ownerDocument, view = doc.defaultView;
  if (!view) return () => {};
  // 書く前に集める: 親に書いた値が子の判定（継承）を変えないように。
  const candidates: Element[] = [...(root.nodeType === 1 ? [root as Element] : []), ...root.querySelectorAll('*')];
  const targets = candidates.flatMap(element => {
    const node = element as StyledElement;
    if (!node.style || ['STYLE', 'SCRIPT'].includes(node.tagName)) return [];
    if (!node.style.fontFamily && !Array.from(node.childNodes).some(child => child.nodeType === 3 && child.textContent)) return [];
    const computed = view.getComputedStyle(node).fontFamily;
    const pin = GENERIC_FONT_PINS[firstFontFamily(computed) ?? ''];
    if (!pin) return [];
    return [{ node, value: node.style.getPropertyValue('font-family'), priority: node.style.getPropertyPriority('font-family'), hadStyle: node.hasAttribute('style'), pinned: `"${pin}", ${computed}` }];
  });
  if (!targets.length) return () => {};
  const applied = targets.map(target => {
    target.node.style.setProperty('font-family', target.pinned, target.priority);
    return { ...target, applied: target.node.style.getPropertyValue('font-family') };
  });
  return () => {
    for (const { node, value, priority, hadStyle, applied: owned } of applied) {
      // 後から React や利用者が書いた値はその人のもの。戻してはいけない。
      if (node.style.getPropertyValue('font-family') !== owned || node.style.getPropertyPriority('font-family') !== priority) continue;
      if (value) node.style.setProperty('font-family', value, priority);
      else node.style.removeProperty('font-family');
      if (!hadStyle && !node.style.length) node.removeAttribute('style');
    }
  };
}
