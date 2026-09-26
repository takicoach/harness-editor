/** @vitest-environment jsdom */
// src/app/native/NativeSwitch.test.tsx
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeSwitch } from './NativeSwitch';

afterEach(cleanup);

it('チェックボックスをラベルで包み、状態を data-checked にも出す', () => {
  const onChange = vi.fn();
  const view = render(<NativeSwitch label="自動保存" checked onChange={onChange} />);
  const input = view.getByLabelText('自動保存') as HTMLInputElement;
  expect(input.type).toBe('checkbox');
  expect(input.checked).toBe(true);
  expect(view.container.querySelector('.native-switch')!.getAttribute('data-checked')).toBe('true');
  fireEvent.click(input);
  expect(onChange).toHaveBeenCalledWith(false);
});

it('disabled のときは押せない', () => {
  const onChange = vi.fn();
  const view = render(<NativeSwitch label="自動保存" checked={false} onChange={onChange} disabled />);
  const input = view.getByLabelText('自動保存') as HTMLInputElement;
  expect(input.disabled).toBe(true);
  fireEvent.click(input);
  expect(onChange).not.toHaveBeenCalled();
});
