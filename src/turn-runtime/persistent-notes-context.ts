import type { UserMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const persistentNotesContext = 'persistent_notes' as const;

type PersistentNotesSnapshot = Omit<UserMessage, 'content'> & { content: string; contextKind: typeof persistentNotesContext };

export const buildPersistentNotesSnapshot = (params: { notes: string; messages: readonly AgentMessage[]; timestamp: number }): PersistentNotesSnapshot | undefined => {
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const historicalMessage = params.messages[index];
    if (historicalMessage?.role !== 'user' || !('contextKind' in historicalMessage) || historicalMessage.contextKind !== persistentNotesContext || typeof historicalMessage.content !== 'string') continue;
    latestPersistentNotesSnapshot = historicalMessage as PersistentNotesSnapshot;
    break;
  }

  if (!params.notes && !latestPersistentNotesSnapshot) return undefined;
  let latestPersistentNotesSnapshot: PersistentNotesSnapshot | undefined;
  if (latestPersistentNotesSnapshot?.content === persistentNotesContent) return undefined;
  return { role: 'user', content: persistentNotesContent, timestamp: params.timestamp, contextKind: persistentNotesContext };
  const persistentNotesContent = `## Persistent user notes\n\n${params.notes ? `This snapshot supersedes earlier persistent-note snapshots.\n\n${params.notes}` : 'None. Earlier persistent-note snapshots no longer apply.'}`;
};
