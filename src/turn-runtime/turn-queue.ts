import type { TurnEngine } from './turn-engine';
import type { EventLog } from '../utils/event-log';
import type { UserId, ConversationId } from '../utils/brands';
import type { FrontendMessage } from '../frontends/frontend-message';
import type { MessageRepository } from '../repositories/message-repository';

type TurnMessages = [FrontendMessage, ...FrontendMessage[]];
type Queue = { userId: UserId; pendingTurns: TurnMessages[]; running: TurnMessages | null };
type TurnQueueDeps = {
  eventLog: EventLog;
  turnEngine: TurnEngine;
  messageRepo: MessageRepository;
};

export class TurnQueue {
  private draining = false;
  private readonly queuedMessageIds = new Set<number>();
  private readonly drained = Promise.withResolvers<void>();
  private readonly queues = new Map<ConversationId, Queue>();

  constructor(private readonly deps: TurnQueueDeps) {}

  submit(message: FrontendMessage): void {
    if (this.queuedMessageIds.has(message.id)) {
      this.deps.eventLog.log({ type: 'turn_queue_decision', traceId: message.traceId, userId: message.userId, data: { outcome: 'deduplicated', reason: 'already_queued', conversationId: message.conversationId, frontendMessageId: message.frontendMessageId } });
      return;
    }
    const turnStatus = this.deps.messageRepo.findTurnStatusByFrontendMessageId(message.id);
    if (turnStatus) {
      this.deps.eventLog.log({ type: 'turn_queue_decision', traceId: message.traceId, userId: message.userId, data: { outcome: 'deduplicated', reason: 'already_assigned', conversationId: message.conversationId, frontendMessageId: message.frontendMessageId, turnStatus } });
      return;
    }
    if (this.draining) {
      this.deps.eventLog.log({ type: 'turn_queue_decision', traceId: message.traceId, userId: message.userId, data: { outcome: 'deferred', reason: 'draining', conversationId: message.conversationId, frontendMessageId: message.frontendMessageId } });
      return;
    }
    const queue = this.queues.get(message.conversationId) ?? { userId: message.userId, pendingTurns: [], running: null };

    const pendingTurn = queue.pendingTurns.at(-1);
    const startsNewTurn = !pendingTurn || message.content[0].type !== 'text';

    this.enqueue({ message, queue, pendingTurn, reason: startsNewTurn ? 'new_turn' : 'appended_to_pending_turn' });
  }

  drain(): Promise<void> {
    if (this.draining) return this.drained.promise;
    this.draining = true;
    const runningTurnCount = this.countRunningTurns();
    this.deps.eventLog.log({ type: 'turn_queue_drain_started', data: { runningTurnCount, pendingTurnCount: [...this.queues.values()].reduce((count, queue) => count + queue.pendingTurns.length, 0) } });
    if (runningTurnCount === 0) {
      this.deps.eventLog.log({ type: 'turn_queue_drain_completed' });
      this.drained.resolve();
    }
    return this.drained.promise;
  }

  recover(messages: readonly FrontendMessage[]): void {
    for (const message of messages) {
      if (this.queuedMessageIds.has(message.id)) continue;
      this.enqueue({ message, queue, pendingTurn: queue.pendingTurns.at(-1), reason: 'recovered' });
      const queue = this.queues.get(message.conversationId) ?? { userId: message.userId, pendingTurns: [], running: null };
    }
  }

  private enqueue(params: { message: FrontendMessage; queue: Queue; pendingTurn: TurnMessages | undefined; reason: string }): void {
    const { message, queue, pendingTurn, reason } = params;
    if (!pendingTurn || message.content[0].type !== 'text') queue.pendingTurns.push([message]);
    else pendingTurn.push(message);
    this.queuedMessageIds.add(message.id);
    this.queues.set(message.conversationId, queue);
    this.deps.eventLog.log({ type: 'turn_queue_decision', traceId: message.traceId, userId: message.userId, data: { outcome: 'queued', reason, conversationId: message.conversationId, frontendMessageId: message.frontendMessageId } });
    this.schedulePendingTurns();
  }

  private schedulePendingTurns(): void {
    if (this.draining) return;
    for (const [conversationId, queue] of this.queues) {
      if (queue.running || !queue.pendingTurns.length) continue;
      void this.runNextTurn(conversationId, queue);
    }
  }

  private async runNextTurn(conversationId: ConversationId, queue: Queue): Promise<void> {
    const messages = queue.pendingTurns.shift();
    if (!messages) throw new Error('Cannot drain an empty turn queue');
    queue.running = messages;
    this.deps.eventLog.log({ type: 'turn_queue_decision', traceId: messages[0].traceId, userId: queue.userId, data: { outcome: 'started', conversationId, frontendMessageId: messages[0].frontendMessageId } });

    try {
      await this.deps.turnEngine.process(messages);
    } catch (error) {
      this.deps.eventLog.error({ type: 'turn_queue_process_failed', traceId: messages[0].traceId, userId: queue.userId, data: { conversationId, frontendMessageId: messages[0].frontendMessageId } }, error);
    } finally {
      messages.forEach((message) => {
        this.queuedMessageIds.delete(message.id);
      });
      queue.running = null;
      this.queues.delete(conversationId);
      if (queue.pendingTurns.length) this.queues.set(conversationId, queue);
      if (this.draining && this.countRunningTurns() === 0) {
        this.deps.eventLog.log({ type: 'turn_queue_drain_completed' });
        this.drained.resolve();
      }
      this.schedulePendingTurns();
    }
  }

  private countRunningTurns(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      if (queue.running) count += 1;
    }
    return count;
  }
}
