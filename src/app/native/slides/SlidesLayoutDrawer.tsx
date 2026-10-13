import { useState } from 'react';
import { FONTS } from '../../../core/fonts';
import { placeholderFields } from '../../../core/slides/build';
import { layoutSlots, SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import { SLIDE_COLOR_ROLES, SLIDE_FONT_ROLES, SLIDE_LAYOUT_IDS, SLIDE_THEME_IDS, type SlideColorRole, type SlideFontRole, type SlideLayoutId, type SlideThemeChoice } from '../../../core/slides/model';
import { resolveSlideTheme, SLIDE_COLOR_LABELS, SLIDE_THEMES } from '../../../core/slides/themes';
import { ThumbnailColorInput } from '../thumbnail/ThumbnailKnob';
import type { SlidesDrawerContext } from './SlidesDrawer';

const BUNDLED = FONTS.filter(font => font.group === 'bundled');
const FONT_LABELS: Record<SlideFontRole, string> = { heading: '見出しの書体', body: '本文の書体' };
export function withThemeColor(theme: SlideThemeChoice, role: SlideColorRole, color: string): SlideThemeChoice {
  return { id: theme.id, overrides: { ...theme.overrides, colors: { ...theme.overrides?.colors, [role]: color } } };
}
export function withThemeFont(theme: SlideThemeChoice, role: SlideFontRole, fontId: string): SlideThemeChoice {
  return { id: theme.id, overrides: { ...theme.overrides, fonts: { ...theme.overrides?.fonts, [role]: fontId } } };
}
/** 色の入力は操作中の値を手元に持つ（持たないと、選んでいる途中で元の色へ戻され、確定の値が古くなる）。 */
function ThemeColorField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit(color: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <ThumbnailColorInput label={label} value={draft ?? value} disabled={disabled} onLive={setDraft} onCommit={color => { setDraft(null); onCommit(color); }} />;
}
/** レイアウトの枠の配置の小さな図（背景は除く）。 */
export function LayoutSketch({ layout }: { layout: SlideLayoutId }) {
  return <svg className="native-slides-sketch" viewBox="0 0 1920 1080" aria-hidden="true">
    <rect width="1920" height="1080" className="native-slides-sketch-ground" />
    {layoutSlots(layout, placeholderFields(layout)).slice(1).map(slot => <rect key={slot.id} x={slot.rect.x} y={slot.rect.y} width={slot.rect.width} height={slot.rect.height} rx={24}
      className={slot.kind === 'text' ? 'native-slides-sketch-text' : 'native-slides-sketch-shape'} />)}
  </svg>;
}
/** 左の「レイアウト」: レイアウト 6 種（今のページを変える・新しいページを足す）とテーマ（2 種・色と書体の上書き）。 */
export function SlidesLayoutDrawer({ context }: { context: SlidesDrawerContext }) {
  const { session, document, pageId } = context, index = document.pages.findIndex(page => page.id === pageId), page = document.pages[index];
  const theme = document.theme, resolved = resolveSlideTheme(theme), busy = session.busy;
  const setTheme = (next: SlideThemeChoice) => void session.execute({ type: 'set-theme', theme: next });
  return <div className="native-thumbnail-drawer-list">
    <h3 className="native-thumbnail-subhead">レイアウト</h3>
    <p className="native-thumbnail-note">押すと今のページのレイアウトが変わります（文字と画像は残ります）。</p>
    <ul className="native-slides-layouts">
      {SLIDE_LAYOUT_IDS.map(id => <li key={id} className="native-slides-layout">
        <button type="button" className="btn-secondary native-slides-layout-pick" aria-pressed={page?.layout === id} disabled={!page || busy}
          onClick={() => { if (page) void session.execute({ type: 'set-layout', pageId: page.id, layout: id }); }}><LayoutSketch layout={id} /><span>{SLIDE_LAYOUTS[id].name}</span></button>
        <button type="button" className="btn-ghost" aria-label={`${SLIDE_LAYOUTS[id].name}のページを足す`} disabled={busy} onClick={() => void context.addPage(id, index >= 0 ? index + 1 : undefined)}>新しいページ</button>
      </li>)}
    </ul>
    <h3 className="native-thumbnail-subhead">テーマ</h3>
    <div className="native-slides-row">
      {SLIDE_THEME_IDS.map(id => <button key={id} type="button" className="native-toggle" aria-pressed={theme.id === id} disabled={busy} onClick={() => setTheme({ id })}>{SLIDE_THEMES[id].name}</button>)}
    </div>
    <p className="native-thumbnail-note">テーマを変えると、色と書体だけが変わります（配置は動きません）。手で決めた色と書体はそのまま残ります。</p>
    <div className="native-slides-theme-colors">
      {SLIDE_COLOR_ROLES.map(role => <div key={role} className="native-slides-theme-color"><span>{SLIDE_COLOR_LABELS[role]}</span>
        <ThemeColorField label={`${SLIDE_COLOR_LABELS[role]}の色`} value={resolved.colors[role]} disabled={busy} onCommit={color => setTheme(withThemeColor(theme, role, color))} /></div>)}
    </div>
    {SLIDE_FONT_ROLES.map(role => <label key={role} className="native-slides-theme-font">{FONT_LABELS[role]}
      <select className="native-thumbnail-select" disabled={busy} value={resolved.fontIds[role]} onChange={event => setTheme(withThemeFont(theme, role, event.target.value))}>
        {BUNDLED.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
      </select></label>)}
    <button type="button" className="btn-ghost" disabled={busy || !theme.overrides} onClick={() => setTheme({ id: theme.id })}>色と書体の上書きを外す</button>
  </div>;
}
