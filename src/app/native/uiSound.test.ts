import { afterEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ play: vi.fn(), setEnabled: vi.fn() }));
vi.mock('../../lib/vendor/cuelume/index.js', () => engine);
import { configureUiSound, uiSound } from './uiSound';

afterEach(() => { engine.play.mockClear(); engine.setEnabled.mockClear(); });

describe('uiSound', () => {
  it('OFF のときは鳴らさず、エンジンにも OFF を伝える', () => {
    configureUiSound({ enabled: false, kind: 'soft' });
    expect(engine.setEnabled).toHaveBeenCalledWith(false);
    uiSound('press'); expect(engine.play).not.toHaveBeenCalled();
  });
  it('控えめは tick / toggle / chime', () => {
    configureUiSound({ enabled: true, kind: 'soft' });
    uiSound('press'); uiSound('toggle'); uiSound('success');
    expect(engine.play.mock.calls.map(c => c[0])).toEqual(['tick', 'toggle', 'chime']);
  });
  it('標準は press / toggle / success', () => {
    configureUiSound({ enabled: true, kind: 'standard' });
    uiSound('press'); uiSound('toggle'); uiSound('success');
    expect(engine.play.mock.calls.map(c => c[0])).toEqual(['press', 'toggle', 'success']);
  });
});
