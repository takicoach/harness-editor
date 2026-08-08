/** ホームの表示モード。panel = Notion 風ギャラリー（横並びカード）、kanban = ステータス5列。 */
export type HomeView = 'panel' | 'kanban';

const VIEWS: readonly HomeView[] = ['panel', 'kanban'];
const KEY = 'sme-home-view';

/** localStorage からホーム表示モードを読む。未設定・不正値は panel。 */
export function loadHomeView(): HomeView {
  try {
    const v = localStorage.getItem(KEY);
    return VIEWS.includes(v as HomeView) ? (v as HomeView) : 'panel';
  } catch {
    return 'panel';
  }
}

/** ホーム表示モードを localStorage に保存（失敗は無視）。 */
export function saveHomeView(v: HomeView): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 失敗は無視 */
  }
}
