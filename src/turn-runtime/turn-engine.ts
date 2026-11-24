import { z } from 'zod';
import { settings } from '../settings';
import { stringifyError } from '../utils';
import { buildTurnInput } from './turn-input';
import type { EventLog } from '../utils/event-log';
import type { Models } from '@earendil-works/pi-ai';
import { Agent } from '@earendil-works/pi-agent-core';
import type { RejectionReason } from './rejection-messages';
import { rejectionUserMessage } from './rejection-messages';
import { ImageRecipe } from '../image-requests/image-recipe';
import type { UserId, ConversationId } from '../utils/brands';
import { buildUpdateNotesTool } from '../tools/update-notes-tool';
import { buildAnimateImageTool } from '../tools/animate-image-tool';
import type { FrontendMessage } from '../frontends/frontend-message';
import type { CostRepository } from '../repositories/cost-repository';
import type { UserRepository } from '../repositories/user-repository';
import { buildSubmitResponseTool } from '../tools/submit-response-tool';
import type { buildSystemPrompt } from '../prompts/system-prompt-builder';
import { buildPersistentNotesSnapshot } from './persistent-notes-context';
import type { GeneratedImageSource } from '../image-requests/image-action';
import type { MessageRepository } from '../repositories/message-repository';
import { Characters, type CharacterId } from '../characters/character-catalog';
import type { ImageRequestDispatcher } from '../image-requests/image-request-dispatcher';
import type { AnimateRequestDispatcher } from '../image-requests/animate-request-dispatcher';

type TurnContext = { userId: UserId; traceId: string; replyToFrontendMessageId: string; characterId: CharacterId; conversationId: ConversationId; frontendChannelId: string };

type TurnProcessingStartedEvent = TurnContext & { type: 'turn_processing_started' };
type AssistantResponseReadyEvent = Omit<TurnContext, 'replyToFrontendMessageId'> & { type: 'assistant_response_ready'; replyToFrontendMessageId: string | null; text: string };
type AssistantResponseDelivered = { type: 'assistant_response_delivered'; messages: { messageId: string; text?: string }[] };
export type TurnProcessingFinishedEvent = TurnContext & { type: 'turn_processing_finished'; status: 'completed' | 'failed'; failure?: string };

export type TurnEngineEvents = {
  turnProcessingStarted(event: TurnProcessingStartedEvent): Promise<void>;
  turnProcessingFinished(event: TurnProcessingFinishedEvent): Promise<void>;
  assistantResponseReady(event: AssistantResponseReadyEvent): Promise<AssistantResponseDelivered>;
};

type TurnEngineDeps = {
  models: Models;
  eventLog: EventLog;
  costRepo: CostRepository;
  events: TurnEngineEvents;
  userRepo: UserRepository;
  messageRepo: MessageRepository;
  buildSystemPrompt: typeof buildSystemPrompt;
  imageDispatcher: Pick<ImageRequestDispatcher, 'enqueue'>;
  animateDispatcher: Pick<AnimateRequestDispatcher, 'enqueue'>;
};

const openRouterUsageSchema = z.object({
  provider: z.string().nullish(),
  usage: z.object({ cost: z.number().nonnegative().nullish() }).nullish(),
});

// OpenRouter puts the billed cost on the final usage chunk and names the upstream provider on every chunk; pi-ai keeps
// neither (earendil-works/pi#8940), so read them off the stream as it passes through. Remove once pi-ai surfaces them.
const observeOpenRouterUsage = (upstream: { provider: string | null; costUsd: number | null }): typeof fetch => (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  upstream.provider = null;
  upstream.costUsd = null;
  const response = await fetch(input, init);
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const inspect = (line: string): void => {
    if (!line.startsWith('data: {')) return;
    try {
      const parsed = openRouterUsageSchema.safeParse(JSON.parse(line.slice(6)));
      if (!parsed.success) return;
      const chunk = parsed.data;
      if (chunk.provider) upstream.provider ??= chunk.provider;
      if (typeof chunk.usage?.cost === 'number') upstream.costUsd = chunk.usage.cost;
    } catch {
      // Invalid JSON; the stream itself is passed through untouched.
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush: () => { inspect(pending); },
    transform: (bytes, controller) => { pending += decoder.decode(bytes, { stream: true }); const lines = pending.split('\n'); pending = lines.pop() ?? ''; lines.forEach(inspect); controller.enqueue(bytes); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}) as typeof fetch;

export class TurnEngine {
  constructor(private readonly deps: TurnEngineDeps) { }

  async process(messages: [FrontendMessage, ...FrontendMessage[]]): Promise<void> {
    const startedAt = Date.now();
    const { userId, characterId, conversationId, traceId, frontend, frontendChannelId } = messages[0];
    const latestMessage = messages.at(-1) ?? messages[0];
    const sourceImageId = latestMessage.content.find((content) => content.type === 'image_action')?.sourceImage.imageId ?? null;
    let turnId: number | null = null;
    let turnContext: TurnContext = { userId, traceId, replyToFrontendMessageId: latestMessage.frontendMessageId, characterId, conversationId, frontendChannelId };
    let failure: unknown;
    try {
      turnId = this.deps.messageRepo.createTurn({ conversationId, frontendMessageIds: messages.map((message) => message.id), traceId });
      turnContext = { ...turnContext, replyToFrontendMessageId: this.deps.messageRepo.findFailureReplyTarget({ traceId, sourceImageId }) ?? latestMessage.frontendMessageId };
      const activeTurnId = turnId;
      await this.deps.events.turnProcessingStarted({ type: 'turn_processing_started', ...turnContext });

      const deliverResponse = async (event: AssistantResponseReadyEvent): Promise<AssistantResponseDelivered> => {
        return this.deps.events.assistantResponseReady(event);
      };

      const { message, sourceImage } = buildTurnInput(messages);
      let currentAssistantMessageId: number | undefined;
      const deliverAssistantText = async (text: string): Promise<void> => {
        const agentMessageId = currentAssistantMessageId;
        if (agentMessageId === undefined) throw new Error('Cannot deliver response before its assistant message is persisted');
        const delivery = await deliverResponse({ type: 'assistant_response_ready', ...turnContext, replyToFrontendMessageId: null, text });
        try {
          delivery.messages.forEach((delivered, index) => {
            this.deps.messageRepo.saveOutboundFrontendMessage({ userId, conversationId, agentMessageId, frontend, frontendMessageId: delivered.messageId, frontendChannelId, chunkIndex: index, text: delivered.text ?? '' });
          });
        } catch (error) {
          this.deps.eventLog.error({ type: 'discord_outbound_message_link_failed', traceId, userId, data: { conversationId, frontendChannelId } }, error);
        }
      };

      const failTurn = (error: unknown): void => { failure ??= error; };
      const deliverUserError = async (text: string): Promise<void> => {
        await deliverResponse({ type: 'assistant_response_ready', ...turnContext, replyToFrontendMessageId: turnContext.replyToFrontendMessageId, text });
      };
      const deliverRejection = async (reason: RejectionReason): Promise<void> => {
        await deliverUserError(rejectionUserMessage[reason]);
      };
      const upstream = { provider: null as string | null, costUsd: null as number | null };
      const agent = this.createAgent({ userId, characterId, conversationId, traceId, turnId: activeTurnId, sourceImage, upstream, deliverAssistantText, deliverRejection, failTurn });

      agent.subscribe(async (event) => {
        if (event.type !== 'message_end') return;
        const agentMessage = event.message;
        const agentMessageId = this.deps.messageRepo.appendAgentMessage({ userId, conversationId, turnId: activeTurnId, agentMessage });
        if (agentMessage.role === 'user') {
          this.deps.messageRepo.linkFrontendMessagesToAgentMessage({
            agentMessageId,
            conversationId,
            frontendMessageIds: messages.filter((message) => message.content.every((content) => content.type !== 'image_action')).map((message) => message.id),
          });
          return;
        }
        if (agentMessage.role !== 'assistant') return;
        currentAssistantMessageId = agentMessageId;
        const amountUsd = upstream.costUsd ?? agentMessage.usage.cost.total;
        this.deps.costRepo.save({ source: agentMessage.provider, amountUsd, traceId, userId, data: { agent_message_id: agentMessageId, tokens_in: agentMessage.usage.input, tokens_out: agentMessage.usage.output, total_tokens: agentMessage.usage.totalTokens, cache_read_input_tokens: agentMessage.usage.cacheRead, model: agentMessage.responseModel ?? agentMessage.model, provider: upstream.provider, cost_source: upstream.costUsd === null ? 'catalog' : 'openrouter', cache_creation_input_tokens: agentMessage.usage.cacheWrite } });
        if (agentMessage.stopReason === 'error' || agentMessage.stopReason === 'aborted') {
          failTurn(agentMessage);
        }
      });

      await agent.prompt(message);
      if (!failure) {
        this.deps.eventLog.log({ traceId, type: 'turn_completed', userId, durationMs: Date.now() - startedAt });
        await this.settleTurn({ turnId: activeTurnId, status: 'completed', turnContext });
      } else {
        this.deps.eventLog.error({ traceId, type: 'turn_failed', userId }, failure);
        await this.settleTurn({ turnId: activeTurnId, status: 'failed', turnContext, failure });
      }
    } catch (error) {
      this.deps.eventLog.error({ traceId, type: 'turn_failed_critical', userId, data: { failure } }, error);
      if (turnId !== null) await this.settleTurn({ turnId, status: 'failed', turnContext, failure: error });
      throw error;
    }
  }

  private async settleTurn(params: { turnId: number; turnContext: TurnContext; status: 'completed' | 'failed'; failure?: unknown }): Promise<void> {
    const { turnId, turnContext, status } = params;
    this.deps.messageRepo.finishTurn(status === 'failed' ? { turnId, status: 'failed', failure: stringifyError(params.failure) } : { turnId, status: 'completed' });
    await this.deps.events.turnProcessingFinished({ type: 'turn_processing_finished', ...turnContext, status, ...(status === 'failed' ? { failure: stringifyError(params.failure) } : {}) });
  }

  private createAgent(params: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; traceId: string; turnId: number; sourceImage: GeneratedImageSource | null; upstream: { provider: string | null; costUsd: number | null }; deliverAssistantText: (text: string) => Promise<void>; deliverRejection: (reason: RejectionReason) => Promise<void>; failTurn: (error: unknown) => void }): Agent {
    const { userId, characterId, conversationId, traceId, turnId, sourceImage, upstream, deliverAssistantText, deliverRejection, failTurn } = params;
    const { llm: llmSettings, turn } = settings.get();
    const userPersonalization = this.deps.userRepo.getOrCreatePersonalization({ userId, characterId });
    const model = this.deps.models.getModel(llmSettings.provider, llmSettings.model);
    if (!model) throw new Error(`Unknown LLM model: ${llmSettings.provider}/${llmSettings.model}`);
    const history = this.deps.messageRepo.listRecentCompletedTurnMessages({ conversationId, turnStep: llmSettings.conversationHistoryTurnStep, since: Date.now() - llmSettings.conversationHistoryMaxAgeMs });
    const notesSnapshot = buildPersistentNotesSnapshot({ notes: userPersonalization.notes, messages: history, timestamp: Date.now() });
    if (notesSnapshot) {
      this.deps.messageRepo.appendAgentMessage({ userId, conversationId, turnId, agentMessage: notesSnapshot });
      history.push(notesSnapshot);
    }
    const terminalTools = this.buildTerminalTools({ userId, characterId, conversationId, traceId, sourceImage, userPersonalization, deliverAssistantText, deliverRejection });
    const tools = [buildUpdateNotesTool({ userId, characterId, userRepo: this.deps.userRepo }), ...terminalTools];
    const isTerminalTool = (name: string): boolean => terminalTools.some((tool) => tool.name === name);
    let modelRoundCount = 0;
    let hasSuccessfulTerminalAction = false;

    return new Agent({
      toolExecution: 'sequential',
      sessionId: String(conversationId),
      initialState: {
        model,
        tools,
        messages: history,
        thinkingLevel: llmSettings.thinkingLevel,
        systemPrompt: this.deps.buildSystemPrompt({ characterId }),
      },
      beforeToolCall: ({ assistantMessage, toolCall }) => {
        const terminalCallCount = assistantMessage.content.filter((content) => content.type === 'toolCall' && isTerminalTool(content.name)).length;
        if (hasSuccessfulTerminalAction && isTerminalTool(toolCall.name)) return Promise.resolve({ block: true, reason: 'A terminal tool already succeeded; retry only failed auxiliary actions.' });
        if (isTerminalTool(toolCall.name) && terminalCallCount > 1) return Promise.resolve({ block: true, reason: 'Call exactly one terminal tool per turn.' });
        return Promise.resolve(undefined);
      },
      streamFn: (model, context, options) => {
        upstream.costUsd = null;
        return this.deps.models.streamSimple(model, context, {
          ...options,
          timeoutMs: llmSettings.timeoutMs,
          maxRetries: llmSettings.maxRetries,
          maxTokens: llmSettings.maxOutputTokens,
          fetch: observeOpenRouterUsage(upstream),
          maxRetryDelayMs: llmSettings.maxRetryDelayMs,
          headers: { ...options?.headers, 'x-session-id': String(conversationId) },
          samplingParams: { tool_choice: 'required', provider: { order: llmSettings.openRouterProviders, allow_fallbacks: false } },
        });
      },
      shouldStopAfterTurn: ({ toolResults }) => {
        modelRoundCount += 1;
        hasSuccessfulTerminalAction ||= toolResults.some((result) => isTerminalTool(result.toolName) && !result.isError);
        const hasAuxiliaryError = toolResults.some((result) => result.isError && !isTerminalTool(result.toolName));
        if (hasSuccessfulTerminalAction && toolResults.length > 0 && !hasAuxiliaryError) return true;
        if (toolResults.length === 0) {
          failTurn('assistant completed without a user-facing action');
          return true;
        }
        if (modelRoundCount >= turn.maxModelRounds) {
          failTurn(`assistant failed to complete the turn after ${String(turn.maxModelRounds)} model rounds`);
          return true;
        }
        return false;
      },
    });
  }

  private buildTerminalTools(params: { userId: UserId; characterId: CharacterId; conversationId: ConversationId; traceId: string; sourceImage: GeneratedImageSource | null; userPersonalization: ReturnType<UserRepository['getOrCreatePersonalization']>; deliverAssistantText: (text: string) => Promise<void>; deliverRejection: (reason: RejectionReason) => Promise<void> }) {
    const { userId, characterId, conversationId, traceId, sourceImage, userPersonalization, deliverAssistantText, deliverRejection } = params;
    return [
      buildSubmitResponseTool({
        submit: async ({ reply, prompts }) => {
          if (reply) await deliverAssistantText(reply);
          if (prompts.length > 0) {
            const result = this.deps.imageDispatcher.enqueue({
              userId,
              traceId,
              characterId,
              conversationId,
              requests: prompts.map((prompt) => ({
                sourceImageId: sourceImage?.imageId ?? null,
                generationSpec: ImageRecipe.create({
                  prompt,
                  image: Characters[characterId].image,
                  seed: Math.floor(Math.random() * 2_147_483_647),
                  detailPassEnabled: userPersonalization.detailPassEnabled,
                  loras: sourceImage?.loras ?? userPersonalization.loraSettings.pinnedLoras,
                }),
              })),
            });
            if (result.kind === 'rejected') await deliverRejection(result.reason);
          }
        },
      }),
      buildAnimateImageTool({ userId, traceId, characterId, conversationId, sourceImageId: sourceImage?.imageId ?? null, animateDispatcher: this.deps.animateDispatcher, sendReply: deliverAssistantText, onRejected: deliverRejection }),
    ];
  }
}
