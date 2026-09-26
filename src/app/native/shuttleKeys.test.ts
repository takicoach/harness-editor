import { describe, it, expect, vi } from 'vitest';
import { shuttleAction, SLOW_RATE, shuttleKeyDown, shuttleKeyUp, shuttleBlur, type ShuttleKeyState, type ShuttlePlayer } from './shuttleKeys';

const idle = { rate: 1, playing: false, kHeld: false };

describe('shuttleAction（J/K/L）', () => {
  it('停止中の L は等速の順再生', () => {
    expect(shuttleAction(idle, 'l', false)).toEqual({ kind: 'play', rate: 1 });
  });
  it('L 連打で 1→2→4→8、8 で頭打ち', () => {
    let state = { ...idle, playing: true, rate: 1 };
    for (const expected of [2, 4, 8, 8]) {
      expect(shuttleAction(state, 'l', false)).toEqual({ kind: 'play', rate: expected });
      state = { ...state, rate: expected };
    }
  });
  it('順再生中の J は等速の逆再生から入り直す', () => {
    expect(shuttleAction({ rate: 4, playing: true, kHeld: false }, 'j', false)).toEqual({ kind: 'play', rate: -1 });
  });
  it('K は停止', () => {
    expect(shuttleAction({ rate: 4, playing: true, kHeld: false }, 'k', false)).toEqual({ kind: 'pause' });
  });
  it('K を押しながら J / L は 1 コマ送り', () => {
    const held = { ...idle, kHeld: true };
    expect(shuttleAction(held, 'j', false)).toEqual({ kind: 'step', delta: -1 });
    expect(shuttleAction(held, 'l', false)).toEqual({ kind: 'step', delta: 1 });
  });
  it('Shift+J / L はスロー ±0.5 で、連打しても加速しない', () => {
    expect(shuttleAction(idle, 'l', true)).toEqual({ kind: 'play', rate: SLOW_RATE });
    expect(shuttleAction({ rate: SLOW_RATE, playing: true, kHeld: false }, 'l', true)).toEqual({ kind: 'play', rate: SLOW_RATE });
    expect(shuttleAction(idle, 'j', true)).toEqual({ kind: 'play', rate: -SLOW_RATE });
  });
  it('スロー中に Shift 無しの L を押すと等速に戻る', () => {
    expect(shuttleAction({ rate: SLOW_RATE, playing: true, kHeld: false }, 'l', false)).toEqual({ kind: 'play', rate: 1 });
  });
  it('最高速度の設定で 4 倍に制限できる', () => {
    expect(shuttleAction({ rate: 4, playing: true, kHeld: false }, 'l', false, 4)).toEqual({ kind: 'play', rate: 4 });
  });
});

function fakePlayer(): ShuttlePlayer { return { stop: vi.fn(), seekBy: vi.fn(), shuttle: vi.fn() }; }
function fakeEvent(key: string, overrides: Partial<{ repeat: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) {
  return { key, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...overrides };
}

describe('shuttleKeyDown（キー配線）', () => {
  it('k で stop、続く l は seekBy(1)（shuttle は呼ばれない）', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    expect(shuttleKeyDown(fakeEvent('k'), state, player)).toBe(true);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(shuttleKeyDown(fakeEvent('l'), state, player)).toBe(true);
    expect(player.seekBy).toHaveBeenCalledWith(1);
    expect(player.shuttle).not.toHaveBeenCalled();
  });
  it('keyup k のあとの l は shuttle', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    shuttleKeyDown(fakeEvent('k'), state, player);
    shuttleKeyUp({ key: 'k' }, state);
    shuttleKeyDown(fakeEvent('l'), state, player);
    expect(player.shuttle).toHaveBeenCalledWith('l', false, undefined);
  });
  it('blur のあとの l も shuttle', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    shuttleKeyDown(fakeEvent('k'), state, player);
    shuttleBlur(state);
    shuttleKeyDown(fakeEvent('l'), state, player);
    expect(player.shuttle).toHaveBeenCalledWith('l', false, undefined);
  });
  it('k の repeat:true は stop を呼ばず、l の repeat:true は何もしない（戻り値は true）', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    expect(shuttleKeyDown(fakeEvent('k', { repeat: true }), state, player)).toBe(true);
    expect(player.stop).not.toHaveBeenCalled();
    expect(shuttleKeyDown(fakeEvent('l', { repeat: true }), state, player)).toBe(true);
    expect(player.shuttle).not.toHaveBeenCalled();
    expect(player.seekBy).not.toHaveBeenCalled();
  });
  it('Task 3 m2: shiftKey と maxRate をそのまま player.shuttle へ渡す', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    shuttleKeyDown(fakeEvent('l', { shiftKey: true }), state, player, 4);
    expect(player.shuttle).toHaveBeenCalledWith('l', true, 4);
    shuttleKeyDown(fakeEvent('j', { shiftKey: true }), state, player, 8);
    expect(player.shuttle).toHaveBeenLastCalledWith('j', true, 8);
  });
  it('metaKey:true の k は戻り値 false で preventDefault も呼ばれない（⌘K の分割へ流す）', () => {
    const player = fakePlayer(), state: ShuttleKeyState = { kHeld: false };
    const event = fakeEvent('k', { metaKey: true });
    expect(shuttleKeyDown(event, state, player)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
  });
});
