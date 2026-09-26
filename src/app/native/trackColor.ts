import type { TrackAccent } from './trackAccent';

export type TrackColorOverrides = Record<string, TrackAccent>;
const TOKENS = new Set<string>(['--track-video', '--track-jimaku', '--track-title', '--track-telop', '--track-image', '--track-vi', '--track-bgm', '--track-se', '--track-shape']);
const key = (projectId: string, documentId: string) => `harness-native-track-colors:${projectId}:${documentId}`;

/** トラック色の上書き（F7 の 3 段目）。表示の好みなので文書には入れず、案件 × 文書ごとに localStorage へ。 */
export function loadTrackColors(projectId: string, documentId: string): TrackColorOverrides {
  try {
    const raw = localStorage.getItem(key(projectId, documentId));
    if (!raw || raw.length > 8192) return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const out: TrackColorOverrides = {};
    for (const [id, token] of Object.entries(value)) if (typeof token === 'string' && TOKENS.has(token)) out[id] = token as TrackAccent;
    return out;
  } catch { return {}; }
}
export function saveTrackColors(projectId: string, documentId: string, colors: TrackColorOverrides): void {
  try {
    if (Object.keys(colors).length) localStorage.setItem(key(projectId, documentId), JSON.stringify(colors));
    else localStorage.removeItem(key(projectId, documentId));
  } catch { /* 表示の好みなので失っても編集には影響しない */ }
}
