import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInstructionInbox } from './instructionInbox';
import { wireInboxPersistence } from './inboxServerLifecycle';

class ServerLifecycle extends EventEmitter { listening = false; }
const deps = { resolveProjectDir: (id: string) => `/fixture/${id}` };
const input = (text: string) => ({ projectId: 'fixture', projectDir: '/fixture/fixture', text, context: { frame: 0, timeSec: 0, selection: null } });

describe('Viteの作成→旧サーバclose→新listenの永続化所有権', () => {
  it('新サーバのconfigure時に旧所有者から奪わず、listen時に引き継ぐ', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-lifecycle-'));
    const file = join(directory, 'inbox.json');
    const oldInbox = createInstructionInbox(); const newInbox = createInstructionInbox();
    const oldServer = new ServerLifecycle(); const newServer = new ServerLifecycle();
    const oldAttached = vi.fn(); const newAttached = vi.fn();
    try {
      wireInboxPersistence(oldServer, oldInbox, file, deps, oldAttached);
      oldServer.listening = true; oldServer.emit('listening');
      expect(oldAttached).toHaveBeenLastCalledWith(true);
      oldInbox.enqueue(input('旧サーバで受付'));
      wireInboxPersistence(newServer, newInbox, file, deps, newAttached);
      expect(newAttached).not.toHaveBeenCalled();
      oldServer.emit('close');
      newServer.listening = true; newServer.emit('listening');
      expect(newAttached).toHaveBeenCalledExactlyOnceWith(true);
      expect(newInbox.list('fixture')).toHaveLength(1);
      newInbox.enqueue(input('再起動後の受付'));
      expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(2);
    } finally {
      oldInbox.releasePersistence(); newInbox.releasePersistence(); rmSync(directory, { recursive: true, force: true });
    }
  });
  it('実際に同じ場所で別サーバが稼働中なら二重取得しない', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-lifecycle-'));
    const file = join(directory, 'inbox.json');
    const owner = createInstructionInbox(); const other = createInstructionInbox();
    const first = new ServerLifecycle(); const second = new ServerLifecycle();
    first.listening = true; second.listening = true;
    const denied = vi.fn();
    try {
      wireInboxPersistence(first, owner, file, deps, vi.fn());
      wireInboxPersistence(second, other, file, deps, denied);
      expect(denied).toHaveBeenCalledExactlyOnceWith(false);
      second.emit('close'); // The non-owner must not remove the owner's lock.
      expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
    } finally {
      owner.releasePersistence(); other.releasePersistence(); rmSync(directory, { recursive: true, force: true });
    }
  });
  it('同じ受け箱を共有する非所有サーバのcloseでは所有lockを解放しない', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-lifecycle-'));
    const file = join(directory, 'inbox.json');
    const inbox = createInstructionInbox();
    const owner = new ServerLifecycle(); const nonOwner = new ServerLifecycle();
    owner.listening = true; nonOwner.listening = true;
    const ownerAttached = vi.fn(); const nonOwnerAttached = vi.fn();
    try {
      wireInboxPersistence(owner, inbox, file, deps, ownerAttached);
      expect(ownerAttached).toHaveBeenCalledExactlyOnceWith(true);
      wireInboxPersistence(nonOwner, inbox, file, deps, nonOwnerAttached);
      expect(nonOwnerAttached).toHaveBeenCalledExactlyOnceWith(false);

      nonOwner.emit('close');

      expect(readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
      inbox.enqueue(input('所有者close前の受付'));
      expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(1);
    } finally {
      inbox.releasePersistence(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
