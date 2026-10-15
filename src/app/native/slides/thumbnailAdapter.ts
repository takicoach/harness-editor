import { useMemo } from 'react';
import type { SlideCommand, SlideHistoryCommand } from '../../../core/slides/commands';
import { slidePageAsThumbnail } from '../../../core/slides/pageView';
import type { ThumbnailCommand, ThumbnailHistoryCommand } from '../../../core/thumbnail/commands';
import type { ThumbnailSessionState } from '../thumbnail/thumbnailApi';
import type { ThumbnailCommandInput, ThumbnailSessionHook } from '../thumbnail/useThumbnailSession';
import type { SlidesSessionState } from './slidesApi';
import type { SlidesSessionHook } from './useSlidesSession';

const LAYER_COMMANDS: readonly string[] = ['add-layer', 'update-layer', 'delete-layers', 'reorder-layer', 'set-layer-flags'];
/** サムネの部品が出す操作を、スライドの操作へ。レイヤーの 5 つは同じ形。案の操作（スライドに無いもの）は null。 */
export function toSlideCommand(command: ThumbnailCommand | ThumbnailHistoryCommand): SlideCommand | SlideHistoryCommand | null {
  if (command.type === 'undo' || command.type === 'redo') return { type: command.type };
  if (command.type === 'batch') {
    const children = command.commands.map(toSlideCommand);
    return children.every((child): child is SlideCommand => child !== null && child.type !== 'undo' && child.type !== 'redo') ? { type: 'batch', commands: children } : null;
  }
  return LAYER_COMMANDS.includes(command.type) ? command as unknown as SlideCommand : null;
}
/** スライドの 1 ページを、案 1 つだけのサムネ文書の状態として見せる（部品の表示用。保存はスライドの文書）。 */
export function thumbnailViewState(state: SlidesSessionState, pageId: string): ThumbnailSessionState {
  return { sessionId: state.sessionId, document: slidePageAsThumbnail(state.document, pageId), savedRevision: state.savedRevision, savedContentHash: state.savedContentHash,
    canUndo: state.canUndo, canRedo: state.canRedo, dirty: state.dirty, pageHashes: {} };
}
/** サムネの部品に渡すセッション。操作はスライドのコマンドへ変えて送り、画像の取り込みはスライド案件へ入れる。 */
export function useThumbnailSessionView(slides: SlidesSessionHook, pageId: string | null, onUnsupported: (message: string) => void): ThumbnailSessionHook {
  return useMemo(() => {
    const view = (state: SlidesSessionState | null) => state && pageId && state.document.pages.some(page => page.id === pageId) ? thumbnailViewState(state, pageId) : null;
    return {
      state: view(slides.state), phase: slides.phase, broken: null, busy: slides.busy, error: slides.error, notice: slides.notice,
      saveProgress: null, previewTick: slides.previewTick, exportTick: slides.exportTick,
      execute: async (input: ThumbnailCommandInput) => {
        // 文書から作る形のコマンドは、今のページの最新の見え方から作る（サムネの「案を追加」と同じ約束。スライドでは案の操作は使えない）。
        const current = typeof input === 'function' ? view(slides.readCurrent()) : null;
        const command = typeof input === 'function' ? (current ? input(current.document) : null) : input;
        const mapped = command ? toSlideCommand(command) : null;
        if (!mapped) { onUnsupported('この操作はスライドでは使えません'); return false; }
        return slides.execute(mapped);
      },
      save: slides.save, recover: async () => false, uploadImage: slides.uploadImage, registerAssets: slides.registerAssets,
      readCurrent: () => view(slides.readCurrent()), clearError: slides.clearError, clearNotice: slides.clearNotice,
    };
  }, [slides, pageId, onUnsupported]);
}
