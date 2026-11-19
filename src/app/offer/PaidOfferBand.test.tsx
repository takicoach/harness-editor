/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PAID_OFFER_TEXT } from '../../shared/paidOffer';
import { PaidOfferBand } from './PaidOfferBand';

afterEach(cleanup);
it('keeps the note when there is no link and offers an explicit close action', () => {
  const onDismiss = vi.fn();
  const view = render(<PaidOfferBand onDismiss={onDismiss} url=""/>);
  const note = within(view.getByRole('note'));
  expect(note.getByText(PAID_OFFER_TEXT)).toBeTruthy();
  expect(note.queryByRole('link')).toBeNull();
  fireEvent.click(note.getByRole('button',{name:'有料プラグインの案内を閉じる'}));
  expect(onDismiss).toHaveBeenCalledOnce();
  view.rerender(<PaidOfferBand onDismiss={onDismiss} url="https://example.test/plugins"/>);
  expect(within(view.getByRole('note')).getByRole('link',{name:'くわしく見る'}).getAttribute('href')).toBe('https://example.test/plugins');
});

it('links to the published plugin page by default', () => {
  const view = render(<PaidOfferBand onDismiss={() => {}}/>);
  expect(within(view.getByRole('note')).getByRole('link',{name:'くわしく見る'}).getAttribute('href')).toBe('https://video-harness.app/plugin/');
});
