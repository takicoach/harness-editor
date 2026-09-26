import type { InstructionInbox } from './instructionInbox';

interface LifecycleServer {
  readonly listening: boolean;
  once(event: 'listening' | 'close', listener: () => void): unknown;
}
/** Own persistence for exactly the lifetime of one listening Vite server. */
export function wireInboxPersistence(server: LifecycleServer | null, inbox: InstructionInbox,
  file: string, deps: Parameters<InstructionInbox['attachPersistence']>[1], onAttached: (persisted: boolean) => void): void {
  let ownsPersistence = false;
  const attach = () => {
    ownsPersistence = inbox.attachPersistence(file, deps).persisted;
    onAttached(ownsPersistence);
  };
  // Vite creates/configures its replacement before closing the old HTTP server.
  // Acquiring here would fail on the still-live old lock, then silently stay memory-only.
  if (server === null || server.listening) attach();
  else server.once('listening', attach);
  server?.once('close', () => {
    if (!ownsPersistence) return;
    ownsPersistence = false;
    inbox.releasePersistence();
  });
}
