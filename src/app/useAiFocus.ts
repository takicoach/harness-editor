import { useEffect, useMemo, useRef } from 'react';
import type { AiFocusBeat, AiScreen } from '../shared/aiFocus';

/** 画面の状況を送る間隔。サーバは 15 秒届かない画面を忘れる（AI_FOCUS_TTL_MS）。 */
export const AI_FOCUS_BEAT_MS = 2000;
let pageId: string | null = null, sequence = 0;
/** ブラウザのページ 1 枚に 1 つ。案件を切り替えて編集画面が作り直されても変わらない（主画面を保つため）。 */
export function aiPageId(): string { return pageId ??= crypto.randomUUID(); }
export interface AiFocusHandle { pageId: string; screen: AiScreen | null; beat(): AiFocusBeat }
/** すぐ送り直す変化（案件・モード・書き込み先）。再生位置や選択は 2 秒ごとの報告で追いつく。 */
const identity = (screen: AiScreen | null) => screen ? JSON.stringify([screen.projectId, screen.mode, screen.target]) : 'home';
function post(path: string, body: unknown): void {
  // 返事の中身は使わないが読み捨てる。読まないとブラウザは要求を読み込み中のまま残し、2 秒ごとに積み上がる（停止の再現試験の connections-left）。
  try { void fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.body?.cancel()).catch(() => undefined); }
  catch { /* 送れなくても編集は止めない。次の定期報告で追いつく */ }
}
/** 画面の状況をサーバ（/api/ai/focus）へ送る。外したら「ホーム」（null）を送る。順序の入れ替わりは連番でサーバが捨てる。 */
export function useAiFocus(screen: AiScreen | null): AiFocusHandle {
  const id = aiPageId(), latest = useRef(screen);
  latest.current = screen;
  const key = identity(screen);
  const beat = useMemo(() => (): AiFocusBeat => ({ pageId: id, seq: ++sequence, screen: latest.current }), [id]);
  useEffect(() => { post('/api/ai/focus', beat()); }, [key, beat]);
  useEffect(() => {
    const timer = window.setInterval(() => post('/api/ai/focus', beat()), AI_FOCUS_BEAT_MS);
    const release = () => {
      try { navigator.sendBeacon?.('/api/ai/focus/release', new Blob([JSON.stringify({ pageId: id })], { type: 'application/json' })); }
      catch { /* 届かなくても 15 秒で忘れられる */ }
    };
    window.addEventListener('pagehide', release);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', release);
      post('/api/ai/focus', { pageId: id, seq: ++sequence, screen: null });
    };
  }, [id, beat]);
  return useMemo(() => ({ pageId: id, screen, beat }), [id, screen, beat]);
}
