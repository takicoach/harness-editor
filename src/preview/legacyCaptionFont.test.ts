// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyLegacyCaptionFont } from './legacyCaptionFont';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

function environment() {
  const faces = new Set<unknown>();
  const Face = vi.fn(function(this: object, family: string, source: string, descriptors: object) {
    Object.assign(this, { family, source, status: 'loaded', ...descriptors });
  });
  const frame = document.createElement('iframe'); document.body.append(frame);
  const doc = frame.contentDocument!;
  Object.defineProperty(doc.defaultView, 'FontFace', { configurable: true, value: Face });
  Object.defineProperty(doc, 'fonts', { configurable: true, value: faces });
  const root = doc.createElement('div'); doc.body.append(root);
  return { root, faces, Face };
}
function text(root: Element, family = '"Noto Sans JP", sans-serif', weight = '800') {
  const span = document.createElement('span'); span.textContent = '同じ ABC 123';
  span.style.fontFamily = family; span.style.fontWeight = weight; span.style.color = 'red';
  root.append(span); return span;
}

it('changes only unresolved old default fallback and restores authored DOM exactly', () => {
  const { root, Face, faces } = environment(); const node = text(root); const before = node.outerHTML;
  const cleanup = applyLegacyCaptionFont(root);
  expect(node.style.fontFamily).toMatch(/Noto Sans JP.*HarnessLegacyCaption.*sans-serif/);
  expect(node.style.fontWeight).toBe('800'); expect(node.style.color).toBe('red');
  expect(Face).toHaveBeenCalledWith(expect.any(String), 'local("HiraKakuProN-W6")', { weight: '600', style: 'normal' });
  expect(faces.size).toBe(1); cleanup(); expect(node.outerHTML).toBe(before);
});

it('leaves explicit faces, custom prefixes and other weights untouched', () => {
  const { root, Face } = environment();
  for (const [family, weight] of [['Arial, sans-serif','800'],['"Author Face", "Noto Sans JP", sans-serif','800'],['"Noto Sans JP", "Hiragino Sans", sans-serif','800'],['"Noto Sans JP", sans-serif','900'],['"Noto Sans JP", sans-serif','600']]) text(root,family,weight);
  const before = root.innerHTML; applyLegacyCaptionFont(root)();
  expect(root.innerHTML).toBe(before); expect(Face).not.toHaveBeenCalled();
});

it('does not overwrite a new authored font or unrelated edits when cleaning up', () => {
  const { root } = environment(); const a=text(root), b=text(root); const cleanup=applyLegacyCaptionFont(root);
  a.style.fontFamily='Arial'; b.style.color='blue'; cleanup();
  expect(a.style.fontFamily).toBe('Arial'); expect(b.style.fontFamily).toBe('"Noto Sans JP", sans-serif'); expect(b.style.color).toBe('blue');
});

it('keeps inherited defaults eligible and preserves important declaration priority', () => {
  const { root } = environment(); root.style.fontFamily='"Noto Sans JP", sans-serif'; root.style.fontWeight='800';
  const span=document.createElement('span'); span.textContent='字幕'; root.append(span);
  const explicit=text(root); explicit.style.removeProperty('font-family'); explicit.style.setProperty('font-family','"Noto Sans JP", sans-serif','important');
  const before=root.outerHTML; const cleanup=applyLegacyCaptionFont(root);
  expect(explicit.style.getPropertyPriority('font-family')).toBe('important');
  expect(root.style.fontFamily).toContain('HarnessLegacyCaption'); cleanup(); expect(root.outerHTML).toBe(before);
});

it('reuses a document-local registration and does nothing without the FontFace API', () => {
  const { root, faces } = environment(); text(root); const cleanup=applyLegacyCaptionFont(root); cleanup(); applyLegacyCaptionFont(root)();
  expect(faces.size).toBe(1);
  Object.defineProperty(root.ownerDocument.defaultView, 'FontFace', { value: undefined }); const before=root.innerHTML; applyLegacyCaptionFont(root)(); expect(root.innerHTML).toBe(before);
});

it('handles a missing local face without retries or dropping the original generic fallback', async () => {
  const { root, faces } = environment(); const node=text(root); applyLegacyCaptionFont(root)();
  const face=[...faces][0] as {status:string;load:()=>Promise<unknown>}; face.status='unloaded';
  face.load=vi.fn(()=>{face.status='error';return Promise.reject(new Error('local face unavailable'));});
  const cleanup=applyLegacyCaptionFont(root); await Promise.resolve();
  expect(node.style.fontFamily).toMatch(/Noto Sans JP.*HarnessLegacyCaption.*sans-serif$/);
  cleanup(); applyLegacyCaptionFont(root)(); expect(face.load).toHaveBeenCalledTimes(1);
});
