import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorProject } from '../../core/types';
import { legacyPreviewReferences, legacyPreviewResourceKey, projectLegacyPreview, type LegacyPreviewCatalog } from '../../core/sequence/legacyPreview';
import type { SequenceDocument } from '../../core/sequence/model';

interface Owner { projectId: string; key: string; reload: unknown; epoch: number }
interface Prepared { owner: Owner; token: string; catalog: LegacyPreviewCatalog }
type Notices = ReturnType<typeof projectLegacyPreview>['notices'];
export type LegacyPreviewState = { retry(): void } & (
  | { status: 'pending'; document: null; legacyContext?: undefined; notices: Notices; error: null }
  | { status: 'failed'; document: null; legacyContext?: undefined; notices: Notices; error: string }
  | { status: 'ready'; projectId: string; document: SequenceDocument; legacyContext: string; notices: Notices; error: null }
);
/** Keeps legacy EditState authoritative. Resource preparation is independent of
 * per-keystroke projection; stale preparations cannot replace the active draft.
 * `reload` must be stable between reload operations (e.g. a counter); a fresh
 * object on each render would repeatedly release and prepare resources. */
export function useLegacyPreview(projectId: string, project: EditorProject, reload: unknown): LegacyPreviewState {
  const key = legacyPreviewResourceKey(legacyPreviewReferences(project));
  const previewId = useMemo(() => crypto.randomUUID(), [projectId]);
  const generation = useRef(0);
  const [epoch, setEpoch] = useState(0), [prepared, setPrepared] = useState<Prepared | null>(null);
  const owner = useMemo(() => ({ projectId, key, reload, epoch }), [projectId, key, reload, epoch]);
  const [failure, setFailure] = useState<{ owner: Owner; message: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let live = true, token: string | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    const url = (context?: string) => `/api/legacy-preview?${new URLSearchParams({ id: projectId, ...(context ? { context } : {}) })}`;
    const release = (context: string) => { void fetch(url(context), { method: 'DELETE', keepalive: true }).catch(() => undefined); };
    void (async () => {
      try {
        const response = await fetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legacyPreviewReferences(project)), signal: controller.signal });
        const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'プレビュー素材を準備できません');
        token = body.token;
        if (!live) { if (token) release(token); return; }
        setPrepared({ owner, token: body.token, catalog: body.catalog });
        // A paused edit still owns its resources. Server expiry handles crashed tabs.
        heartbeat = setInterval(() => { void fetch(url(token), { signal: controller.signal }).then(response => {
          if (live && !response.ok) setFailure({ owner, message: 'プレビュー素材の接続を確認できません。再読み込みしてください。' });
        }).catch(() => {
          if (live && !controller.signal.aborted) setFailure({ owner, message: 'プレビュー素材の接続を確認できません。再読み込みしてください。' });
        }); }, 20 * 60 * 1000);
      } catch (error) {
        if (live && !controller.signal.aborted) setFailure({ owner, message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { live = false; controller.abort(); clearInterval(heartbeat); if (token) release(token); };
  }, [owner]);
  const matches = (value: { owner: Owner } | null) => value?.owner === owner;
  const active = matches(prepared) ? prepared : null;
  const projected = useMemo(() => {
    if (!active) return null;
    try { return projectLegacyPreview(project, active.catalog, previewId, ++generation.current, projectId); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [project, active, previewId, projectId]);
  const retry = () => setEpoch(value => value + 1);
  const error = projected && 'error' in projected ? projected.error : matches(failure) ? failure!.message : null;
  if (error !== null) return { status: 'failed', document: null, notices: [], error, retry };
  if (active && projected && 'document' in projected) return { status: 'ready', projectId, document: projected.document,
    legacyContext: active.token, notices: projected.notices, error: null, retry };
  return { status: 'pending', document: null, notices: [], error: null, retry };
}
