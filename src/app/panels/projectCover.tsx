import { useState, type ReactNode } from 'react';
import type { ProjectSummary } from '../../shared/types';

/** カードの画像（サムネのメインの案の書き出し）の URL。無ければ null（従来どおり動画のコマ）。更新時刻で取り直す。 */
export function projectCoverUrl(project: Pick<ProjectSummary, 'id' | 'thumbnailCover'>): string | null {
  return project.thumbnailCover ? `/api/thumbnail/cover?${new URLSearchParams({ id: project.id, v: String(project.thumbnailCover.mtimeMs) })}` : null;
}
/** カードの画像。無い・読み込めない時は children（従来の動画のコマなど）を出す。書き出し直して URL が変われば読み直す。 */
export function ProjectCover({ project, children }: { project: Pick<ProjectSummary, 'id' | 'thumbnailCover'>; children: ReactNode }) {
  const src = projectCoverUrl(project), [failed, setFailed] = useState<string | null>(null);
  if (src === null || failed === src) return <>{children}</>;
  return <img className="ml-thumb-video-el" src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />;
}
