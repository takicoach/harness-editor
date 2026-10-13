import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEventsSse } from '../eventsApi';
import { slidesService } from './service';

describe('通知チャネル slides', () => {
  it('スライドの変更を SSE の slides チャネルで流す', () => {
    const root = mkdtempSync(join(tmpdir(), 'slides-events-')), project = join(root, 'slides-case'), writes: string[] = [];
    mkdirSync(project);
    const req = new EventEmitter() as unknown as IncomingMessage;
    const res = { writableEnded: false, writeHead() { return res; }, write(chunk: string) { writes.push(chunk); return true; }, end() { return res; } } as unknown as ServerResponse;
    try {
      handleEventsSse(req, res, root, 'slides-case');
      slidesService.notify(project, { type: 'change' });
      expect(writes.some(chunk => chunk.includes('"ch":"slides"') && chunk.includes('"type":"change"'))).toBe(true);
    } finally {
      (req as unknown as EventEmitter).emit('close');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
