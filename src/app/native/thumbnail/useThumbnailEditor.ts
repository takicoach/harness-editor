import { useCallback, useMemo, useState } from 'react';
import type { ThumbnailCommand, ThumbnailHistoryCommand } from '../../../core/thumbnail/commands';
import type { ThumbnailContent, ThumbnailDocument, ThumbnailLayer, ThumbnailPage, ThumbnailVisual } from '../../../core/thumbnail/model';
import type { RenderedSceneGeometry } from '../../../preview/native/renderGeometry';
import { applyOverrides, layerBoxes, type LayerBox, type LayerOverride } from './canvasMath';
import type { ThumbnailSessionHook } from './useThumbnailSession';

export interface LayerPatch { name?: string; visual?: ThumbnailVisual; content?: ThumbnailContent }
export interface ThumbnailEditor {
  projectId: string; session: ThumbnailSessionHook;
  document: ThumbnailDocument; previewDocument: ThumbnailDocument; page: ThumbnailPage; pageId: string; selectPage(pageId: string): void;
  selected: string[]; select(ids: string[]): void;
  overrides: ReadonlyMap<string, LayerOverride>; setOverrides(next: ReadonlyMap<string, LayerOverride> | null): void;
  editingText: string | null; setEditingText(layerId: string | null): void; hiddenLayerIds: ReadonlySet<string>;
  geometry: RenderedSceneGeometry | null; setGeometry(geometry: RenderedSceneGeometry | null): void; boxes: ReadonlyMap<string, LayerBox>;
  unavailableAssetIds: ReadonlySet<string>;
  scale: number; setScale(scale: number): void; zoom: number | 'fit'; setZoom(zoom: number | 'fit'): void;
  disabled: boolean;
  execute(command: ThumbnailCommand | ThumbnailHistoryCommand): Promise<boolean>;
  updateLayers(changes: ReadonlyArray<{ layerId: string; patch: LayerPatch }>): Promise<boolean>;
  addLayer(layer: ThumbnailLayer, index?: number): Promise<boolean>;
  newLayerId(): string;
  registerFlush(flush: () => Promise<boolean>): () => void;
  openKnobs(): void;
  toast(message: string): void;
}
interface EditorInput {
  projectId: string; session: ThumbnailSessionHook; document: ThumbnailDocument; pageId: string; onPage(pageId: string): void; toast(message: string): void;
  unavailableAssetIds: ReadonlySet<string>; flushers: Set<() => Promise<boolean>>; openKnobs(): void;
}
const EMPTY = new Map<string, LayerOverride>();

export function useThumbnailEditor({ projectId, session, document, pageId, onPage, toast, unavailableAssetIds, flushers, openKnobs }: EditorInput): ThumbnailEditor {
  const page = document.pages.find(item => item.id === pageId) ?? document.pages[0]!;
  const [chosen, setChosen] = useState<string[]>([]);
  const selected = useMemo(() => chosen.filter(id => page.layers.some(layer => layer.id === id)), [chosen, page]);
  const [overrides, setOverridesState] = useState<ReadonlyMap<string, LayerOverride>>(EMPTY);
  const [editingText, setEditingText] = useState<string | null>(null), [geometry, setGeometry] = useState<RenderedSceneGeometry | null>(null);
  const [scale, setScale] = useState(1), [zoom, setZoom] = useState<number | 'fit'>('fit');
  const hiddenLayerIds = useMemo(() => new Set(editingText ? [editingText] : []), [editingText]);
  const previewDocument = useMemo(() => applyOverrides(document, page.id, overrides), [document, page.id, overrides]);
  const boxes = useMemo(() => layerBoxes(previewDocument, page.id, geometry), [previewDocument, page.id, geometry]);
  const { execute } = session;
  const updateLayers = useCallback((changes: ReadonlyArray<{ layerId: string; patch: LayerPatch }>) => {
    if (!changes.length) return Promise.resolve(true);
    const commands = changes.map(change => ({ type: 'update-layer' as const, pageId: page.id, layerId: change.layerId, patch: change.patch }));
    return execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands });
  }, [execute, page.id]);
  const addLayer = useCallback(async (layer: ThumbnailLayer, index?: number) => {
    const ok = await execute({ type: 'add-layer', pageId: page.id, layer, ...(index === undefined ? {} : { index }) });
    if (ok) setChosen([layer.id]);
    return ok;
  }, [execute, page.id]);
  return { projectId, session, document, previewDocument, page, pageId: page.id, selectPage: id => { setChosen([]); setOverridesState(EMPTY); onPage(id); },
    selected, select: setChosen, overrides, setOverrides: next => setOverridesState(next ?? EMPTY), editingText, setEditingText, hiddenLayerIds,
    geometry, setGeometry, boxes, unavailableAssetIds, scale, setScale, zoom, setZoom, disabled: !session.state || session.phase !== 'ready',
    execute, updateLayers, addLayer, newLayerId: () => `l-${crypto.randomUUID()}`,
    registerFlush: flush => { flushers.add(flush); return () => { flushers.delete(flush); }; }, openKnobs, toast };
}
