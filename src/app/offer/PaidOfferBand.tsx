import { useLayoutEffect, useRef, useState } from 'react';
import { PAID_OFFER_TEXT, PAID_OFFER_URL } from '../../shared/paidOffer';
import './paid-offer.css';

export function PaidOfferBand({onDismiss, url = PAID_OFFER_URL}: {onDismiss(): void; url?: string}) {
  return <aside className="paid-offer-band" role="note">
    <span>{PAID_OFFER_TEXT}{url && <> <a href={url} target="_blank" rel="noopener noreferrer">くわしく見る</a></>}</span>
    <button type="button" className="btn-ghost" aria-label="有料プラグインの案内を閉じる" onClick={onDismiss}>×</button>
  </aside>;
}

export function usePaidOfferResult(claimPaidOffer?: () => boolean) {
  const [offerJobId, setOfferJobId] = useState<string | null>(null);
  const claim = useRef(claimPaidOffer);
  useLayoutEffect(() => { claim.current = claimPaidOffer; });
  const showPaidOfferFor = (job: {id: string; phase: string; error?: string}) => {
    if (job.phase === 'complete' && !job.error && claim.current?.()) setOfferJobId(job.id);
  };
  return {offerJobId, showPaidOfferFor, dismissPaidOffer: () => setOfferJobId(null)};
}
