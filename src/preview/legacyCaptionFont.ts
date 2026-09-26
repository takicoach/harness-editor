const fallbackName = '__HarnessLegacyCaptionFallbackV1';
const faces = new WeakMap<Document, FontFace>();
const oldDefault = /^\s*(?:"Noto Sans JP"|'Noto Sans JP'|Noto Sans JP)\s*,\s*sans-serif\s*$/i;
type StyledElement = HTMLElement | SVGElement;

/**
 * Only the old default's unspecified fallback is changed. Noto stays first.
 * The local W6 face declares its OS/2 weight (600); authored CSS remains 800.
 * Full coverage includes SPACE: SVG metrics use the primary font's space glyph,
 * and retaining generic Latin glyphs would leave mixed captions inconsistent.
 * Missing local faces fall through to the original generic, without downloads.
 */
export function applyLegacyCaptionFont(root: Element): () => void {
  const doc = root.ownerDocument, view = doc.defaultView;
  if (!view || typeof view.FontFace !== 'function' || !doc.fonts) return () => {};
  // Collect before writing: a parent's inherited style must not change eligibility.
  const targets = [root, ...root.querySelectorAll('*')].flatMap(element => {
    const node = element as StyledElement;
    if (!node.style || ['STYLE','SCRIPT'].includes(node.tagName)) return [];
    if (!node.style.fontFamily && !Array.from(node.childNodes).some(child => child.nodeType === 3 && child.textContent)) return [];
    const computed = view.getComputedStyle(node);
    if (!oldDefault.test(computed.fontFamily) || computed.fontWeight !== '800') return [];
    return [{ node, value: node.style.getPropertyValue('font-family'), priority: node.style.getPropertyPriority('font-family'), hadStyle: node.hasAttribute('style') }];
  });
  if (!targets.length) return () => {};
  let face = faces.get(doc);
  if (!face) {
    face = new view.FontFace(fallbackName, 'local("HiraKakuProN-W6")', { weight: '600', style: 'normal' });
    faces.set(doc, face);
  }
  if (!doc.fonts.has(face)) doc.fonts.add(face);
  // Start loading before the caller's existing fonts.ready barrier. A local
  // face may be absent on another OS; CSS then retains the original generic.
  if (face.status === 'unloaded') void face.load().catch(() => {});
  const applied = targets.map(original => {
    original.node.style.setProperty('font-family', `"Noto Sans JP", "${fallbackName}", sans-serif`, original.priority);
    return { ...original, applied: original.node.style.getPropertyValue('font-family') };
  });
  return () => {
    for (const { node, value, priority, hadStyle, applied: owned } of applied) {
      // A later React/user edit owns its new value; cleanup must not undo it.
      if (node.style.getPropertyValue('font-family') !== owned || node.style.getPropertyPriority('font-family') !== priority) continue;
      if (value) node.style.setProperty('font-family', value, priority);
      else node.style.removeProperty('font-family');
      if (!hadStyle && !node.style.length) node.removeAttribute('style');
    }
  };
}
