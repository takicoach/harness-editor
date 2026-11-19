import { describe, expect, it } from 'vitest';
import { PAID_OFFER_TEXT, PAID_OFFER_URL, shouldShowExportOffer, type ExportOfferContext } from './paidOffer';

const ready = {edition:'free', exportOutcome:'success', shownThisSession:false, tutorialEnabled:true, tutorialRunning:false, setupOpen:false} satisfies ExportOfferContext;

describe('paid plugin notice', () => {
  it('shows the approved text on a successful free-edition export even without a destination', () => {
    expect(PAID_OFFER_TEXT).toBe('有料プラグインを追加すると、素材パック・自動編集・ほかの編集ソフトとの受け渡しが使えます。');
    expect(PAID_OFFER_URL).toBe('https://video-harness.app/plugin/');
    expect(shouldShowExportOffer(ready)).toBe(true);
  });

  it.each<Partial<ExportOfferContext>>([
    {edition:'paid'}, {edition:undefined}, {exportOutcome:'failed'}, {exportOutcome:'cancelled'},
    {exportOutcome:'running'}, {shownThisSession:true}, {tutorialEnabled:false}, {tutorialRunning:true}, {setupOpen:true},
  ])('suppresses the notice for %j', change => {
    expect(shouldShowExportOffer({...ready,...change})).toBe(false);
  });
});
