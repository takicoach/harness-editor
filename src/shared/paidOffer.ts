export type AppEdition = 'free' | 'paid';

export const PAID_OFFER_TEXT = '有料プラグインを追加すると、素材パック・自動編集・ほかの編集ソフトとの受け渡しが使えます。';
export const PAID_OFFER_URL: string = 'https://video-harness.app/plugin/';

export interface ExportOfferContext {
  edition?: AppEdition;
  exportOutcome: 'success' | 'failed' | 'cancelled' | 'running' | 'idle';
  shownThisSession: boolean;
  tutorialEnabled: boolean;
  tutorialRunning: boolean;
  setupOpen: boolean;
}

export function shouldShowExportOffer(context: ExportOfferContext): boolean {
  return context.edition === 'free' && context.exportOutcome === 'success' && !context.shownThisSession
    && context.tutorialEnabled && !context.tutorialRunning && !context.setupOpen;
}
