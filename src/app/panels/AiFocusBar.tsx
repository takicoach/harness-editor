import { AI_MODE_LABEL, type AiFocusView, type AiMode } from '../../shared/aiFocus';

const label = (screen: { projectName: string | null; mode: AiMode | null } | null) =>
  screen && screen.projectName !== null && screen.mode !== null ? `${screen.projectName}／${AI_MODE_LABEL[screen.mode]}` : 'ホーム';
const time = (at: number) => new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
/** 「画面:」は主画面の今、「AI が最後に確認:」は editor_context を最後に呼んだ時。AI の理解を大きく見せない（設計書 2）。 */
export function aiFocusBarText(view: AiFocusView | null): { screen: string; read: string; stale: boolean } {
  const primary = view?.primary ?? null, read = view?.lastRead ?? null;
  const current = primary?.screen ?? null;
  return {
    screen: primary ? `画面: ${label(current)}` : '画面: AI タブを開いている画面がありません',
    read: read ? `AI が最後に確認: ${label(read)}（${time(read.at)}）` : 'AI はまだ画面を確認していません',
    stale: !!(primary && read && (read.projectId !== (current?.projectId ?? null) || read.mode !== (current?.mode ?? null))),
  };
}
export function AiFocusBar({ view }: { view: AiFocusView | null }) {
  const text = aiFocusBarText(view);
  return <div className="clt-focus" aria-label="AI が見ている画面">
    <span className="clt-focus-screen">{text.screen}</span>
    <span className="clt-focus-read" data-stale={text.stale ? 'true' : undefined}>
      {text.read}{text.stale ? '（画面が変わりました。次の依頼で AI が確かめます）' : ''}
    </span>
  </div>;
}
