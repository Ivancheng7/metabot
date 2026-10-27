import type * as http from 'node:http';
import type { Credential } from '../auth/credentials.js';
import type { AgentStore, AgentRecord } from '../agents/agent-store.js';
import type { ChatStore } from '../chat/chat-store.js';
import type { ChatMessage, ChatRun, ChatRunEvent, ChatRunPresentation } from '../chat/chat-types.js';
import type { BusEventHub } from './event-hub.js';
import { MessageStore, type MessageSession } from './message-store.js';

export interface MessageRouteDeps {
  agents: AgentStore;
  messages: MessageStore;
  chat: ChatStore;
  events: BusEventHub;
  deliverRun?: (run: {
    id: string;
    conversationId: string;
    triggerMessageId: string;
    targetAgentRef: string;
    prompt: string;
    engine?: string | null;
    model?: string | null;
    presentation?: ChatRunPresentation | null;
    notification?: 'result' | 'error';
  }) => void;
}
export interface RouteResult {
  status: number;
  body: unknown;
}
const err = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status,
  body: { error, ...extra },
});
const senderRef = (cred: Credential) => (cred.ownerName || cred.botName).toLowerCase();

function resolveAgent(store: AgentStore, ref: string, cred: Credential): AgentRecord | null {
  const agent = store.getByName(ref) || store.getById(ref);
  if (!agent) return null;
  if (
    cred.role === 'admin' ||
    agent.visible ||
    (!!cred.ownerName && (agent.ownerName === cred.ownerName || agent.visibleToOwners.includes(cred.ownerName)))
  )
    return agent;
  return null;
}

function sessionShape(s: MessageSession): MessageSession {
  return s;
}

function ownsAgent(agent: AgentRecord, cred: Credential): boolean {
  return (
    cred.role === 'admin' ||
    agent.ownerCredentialId === cred.id ||
    (!!cred.ownerName && agent.ownerName.toLowerCase() === cred.ownerName.toLowerCase())
  );
}

function canAccessSession(
  deps: MessageRouteDeps,
  session: MessageSession,
  agent: AgentRecord,
  cred: Credential,
): boolean {
  if (session.agentId !== agent.id) return false;
  if (session.roomId && !deps.chat.hasParticipant(session.roomId, 'agent', agent.botName)) return false;
  return (
    ownsAgent(agent, cred) || (!!session.roomId && deps.chat.hasParticipant(session.roomId, 'user', senderRef(cred)))
  );
}

function sessionScope(agent: AgentRecord, cred: Credential): { participantRef?: string; agentRef: string } {
  return { agentRef: agent.botName, ...(ownsAgent(agent, cred) ? {} : { participantRef: senderRef(cred) }) };
}

function titleFromText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function withDerivedTitle(deps: MessageRouteDeps, session: MessageSession): MessageSession {
  if (session.title?.trim() || !session.roomId) return session;
  const title = titleFromText(deps.chat.firstMessageContent(session.roomId) || '');
  return title ? (deps.messages.setSessionTitle(session.id, title) ?? session) : session;
}

function pageNumber(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(fallback === 0 ? 0 : 1, Math.floor(parsed))) : fallback;
}

function isFeishuChatId(value: string): boolean {
  return /^oc_[A-Za-z0-9_-]{3,240}$/.test(value);
}

function originProxyPresentation(
  body: Record<string, unknown>,
  cred: Credential,
  targetAgentRef: string,
  agents: AgentStore,
): ChatRunPresentation | undefined {
  if (body.presentationMode !== 'origin-proxy') return undefined;
  const chatId = typeof body.originChatId === 'string' ? body.originChatId.trim() : '';
  const originBotName = typeof body.originBotName === 'string' ? body.originBotName.trim() : '';
  const senderNames = new Set([cred.botName.trim().toLowerCase(), cred.ownerName.trim().toLowerCase()].filter(Boolean));
  const adminSelectedRegisteredOrigin = cred.role === 'admin' && !!agents.getByName(originBotName);
  if (
    !isFeishuChatId(chatId) ||
    !originBotName ||
    (!senderNames.has(originBotName.toLowerCase()) && !adminSelectedRegisteredOrigin)
  ) {
    throw Object.assign(new Error('invalid_origin_proxy_presentation'), { statusCode: 400 });
  }
  return {
    mode: 'origin-proxy',
    chatId,
    targetAgentRef,
    requestedBy: cred.botName,
    originBotName,
    wakeLead: body.wakeLead !== false,
  };
}

export function registerSession(deps: MessageRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const ref = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const agent = resolveAgent(deps.agents, ref || cred.botName, cred);
  if (!agent) return err(404, 'agent_not_found');
  if (!ownsAgent(agent, cred)) return err(403, 'session_ownership_required');
  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' || !['online', 'resumable', 'offline', 'provisioning'].includes(body.status))
  ) {
    return err(400, 'invalid_session_status');
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
  if (roomId && !deps.chat.hasParticipant(roomId, 'agent', agent.botName)) return err(403, 'session_room_forbidden');
  const requestedId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const existing = requestedId ? deps.messages.getSession(requestedId) : null;
  if (existing && existing.agentId !== agent.id) return err(409, 'session_agent_mismatch');
  if (existing?.roomId && roomId && existing.roomId !== roomId) return err(409, 'session_room_mismatch');
  // Bind a provider session back to the central logical session that created
  // this room. The Bridge's local SessionRegistry UUID is not a Bus address.
  const roomSession = roomId ? deps.messages.findSessionByRoom(agent.id, roomId) : null;
  const session = deps.messages.ensureSession({
    agentId: agent.id,
    agentName: agent.botName,
    id: roomSession?.id ?? (typeof body.sessionId === 'string' ? body.sessionId : undefined),
    provider: typeof body.provider === 'string' ? body.provider : undefined,
    providerSessionId: typeof body.providerSessionId === 'string' ? body.providerSessionId : undefined,
    status: typeof body.status === 'string' ? (body.status as MessageSession['status']) : 'online',
    roomId: roomId || undefined,
    transportChatId: typeof body.transportChatId === 'string' ? body.transportChatId.trim() : undefined,
    transportPlatform: typeof body.transportPlatform === 'string' ? body.transportPlatform.trim() : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
  });
  return { status: 201, body: { session: sessionShape(session) } };
}

export function listSessions(
  deps: MessageRouteDeps,
  agentRef: string,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const agent = resolveAgent(deps.agents, agentRef, cred);
  if (!agent) return err(404, 'agent_not_found');
  const limit = pageNumber(query.get('limit'), 20, 100);
  const offset = pageNumber(query.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  const result = deps.messages.listSessions(agent.id, { limit, offset, ...sessionScope(agent, cred) });
  return {
    status: 200,
    body: {
      agentId: agent.id,
      agentName: agent.botName,
      ...result,
      sessions: result.sessions.map((session) => withDerivedTitle(deps, session)),
      limit,
      offset,
      hasMore: offset + result.sessions.length < result.total,
      nextOffset: offset + result.sessions.length < result.total ? offset + result.sessions.length : null,
    },
  };
}

export function listSessionMessages(
  deps: MessageRouteDeps,
  sessionId: string,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  const session = deps.messages.getSession(sessionId.trim());
  if (!session) return err(404, 'session_not_found');
  const agent = deps.agents.getById(session.agentId);
  if (!agent || !resolveAgent(deps.agents, agent.botName, cred) || !canAccessSession(deps, session, agent, cred))
    return err(404, 'session_not_found');
  const limit = pageNumber(query.get('limit'), 20, 200);
  const before = query.get('before')?.trim() || undefined;
  const messages = session.roomId ? deps.chat.peekMessages(session.roomId, { limit, before }) : [];
  const hasMore =
    !!session.roomId &&
    messages.length === limit &&
    deps.chat.peekMessages(session.roomId, { limit: 1, before: messages[0]!.id }).length > 0;
  return {
    status: 200,
    body: {
      sessionId: session.id,
      agentId: agent.id,
      agentName: agent.botName,
      roomId: session.roomId ?? null,
      sessionStatus: session.status,
      sessionTitle: withDerivedTitle(deps, session).title ?? null,
      messages,
      limit,
      hasMore,
      oldestMessageId: messages[0]?.id ?? null,
    },
  };
}

export function sendMessage(deps: MessageRouteDeps, body: Record<string, unknown>, cred: Credential): RouteResult {
  const ref = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!ref) return err(400, 'agent_id_required');
  const text =
    typeof body.message === 'string' ? body.message.trim() : typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return err(400, 'message_required');
  const agent = resolveAgent(deps.agents, ref, cred);
  if (!agent) return err(404, 'agent_not_found');
  const senderSessionId = typeof body.senderSessionId === 'string' ? body.senderSessionId.trim() : '';
  if (senderSessionId) {
    const senderSession = deps.messages.getSession(senderSessionId);
    const senderAgent = senderSession && deps.agents.getById(senderSession.agentId);
    if (
      !senderSession ||
      !senderAgent ||
      !ownsAgent(senderAgent, cred) ||
      (senderAgent.ownerName || senderAgent.botName).toLowerCase() !== senderRef(cred) ||
      !canAccessSession(deps, senderSession, senderAgent, cred) ||
      (senderSession.roomId && !deps.chat.hasParticipant(senderSession.roomId, 'user', senderRef(cred)))
    )
      return err(403, 'sender_session_ownership_required');
  }
  const requested = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  let session = requested ? deps.messages.getSession(requested) : null;
  if (requested && (!session || session.agentId !== agent.id)) return err(404, 'session_not_found');
  if (session && !canAccessSession(deps, session, agent, cred)) return err(404, 'session_not_found');
  if (session?.status === 'offline') {
    return err(409, 'session_offline', { sessions: [session], agentId: agent.id, agentName: agent.botName });
  }
  if (!session) {
    // Filter before applying the result cap so old resumable sessions cannot
    // be hidden by a burst of newer offline sessions.
    const scope = sessionScope(agent, cred);
    const usable = deps.messages.listSessions(agent.id, { limit: 100, statuses: ['online', 'resumable'], ...scope });
    if (usable.total > 1)
      return err(409, 'session_required', { sessions: usable.sessions, agentId: agent.id, agentName: agent.botName });
    if (usable.total === 1) session = usable.sessions[0]!;
    else {
      const pending = deps.messages.listSessions(agent.id, { limit: 100, statuses: ['provisioning'], ...scope });
      if (pending.total > 1)
        return err(409, 'session_provisioning', {
          sessions: pending.sessions,
          agentId: agent.id,
          agentName: agent.botName,
        });
      if (pending.total === 1) session = pending.sessions[0]!;
      else {
        const listed = deps.messages.listSessions(agent.id, { limit: 100, ...scope });
        if (listed.total > 0)
          return err(409, 'session_offline', {
            sessions: listed.sessions,
            agentId: agent.id,
            agentName: agent.botName,
          });
      }
    }
  }
  if (session && !canAccessSession(deps, session, agent, cred)) return err(404, 'session_not_found');
  const from = senderRef(cred);
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!session) {
    const room = deps.chat.createConversation({
      kind: 'dm',
      title: agent.botName,
      createdBy: from,
      participants: [{ kind: 'agent', ref: agent.botName, displayName: agent.botName }],
    });
    session = deps.messages.ensureSession({
      agentId: agent.id,
      agentName: agent.botName,
      status: 'provisioning',
      roomId: room.id,
      title: titleFromText(text),
    });
  } else if (!session.roomId) {
    const room = deps.chat.createConversation({
      kind: 'dm',
      title: session.title || agent.botName,
      createdBy: from,
      participants: [{ kind: 'agent', ref: agent.botName, displayName: agent.botName }],
    });
    session = deps.messages.ensureSession({
      agentId: agent.id,
      agentName: agent.botName,
      id: session.id,
      roomId: room.id,
      title: session.title || titleFromText(text),
    });
  }
  let presentation: ChatRunPresentation | undefined;
  try {
    presentation = originProxyPresentation(body, cred, agent.botName, deps.agents);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    return err(typeof statusCode === 'number' ? statusCode : 400, (error as Error).message || 'invalid_presentation');
  }
  if (
    !presentation &&
    body.presentationMode === 'child-direct' &&
    session.transportPlatform === 'feishu' &&
    typeof session.transportChatId === 'string' &&
    isFeishuChatId(session.transportChatId)
  ) {
    presentation = {
      mode: 'child-direct',
      chatId: session.transportChatId,
      targetAgentRef: agent.botName,
      requestedBy: cred.botName,
    };
  }
  if (idempotencyKey) {
    const prior = deps.chat.getRunByIdempotency(from, idempotencyKey);
    if (prior) {
      if (prior.targetAgentRef !== agent.botName) return err(409, 'idempotency_key_target_mismatch');
      if (prior.conversationId !== session.roomId) return err(409, 'idempotency_key_session_mismatch');
      if (JSON.stringify(prior.presentation) !== JSON.stringify(presentation ?? null))
        return err(409, 'idempotency_key_presentation_mismatch');
      return {
        status: 202,
        body: {
          ok: true,
          idempotentReplay: true,
          messageId: prior.triggerMessageId,
          sessionId: session.id,
          runId: prior.id,
          correlationId: prior.id,
          agentId: agent.id,
          agentName: agent.botName,
        },
      };
    }
  }
  deps.chat.ensureParticipantUnchecked(session.roomId!, { kind: 'user', ref: from });
  const { message, run, idempotentReplay } = deps.chat.appendMessageAndCreateRun(
    {
      conversationId: session.roomId!,
      kind: 'user',
      senderKind: 'user',
      senderRef: from,
      senderDisplayName: from,
      content: text,
      mentionedAgentRefs: [],
      replyTo: typeof body.replyTo === 'string' ? body.replyTo : undefined,
      senderSessionId: senderSessionId || undefined,
    },
    {
      conversationId: session.roomId!,
      targetAgentRef: agent.botName,
      idempotencyOwner: idempotencyKey ? from : undefined,
      idempotencyKey: idempotencyKey || undefined,
      presentation,
    },
  );
  if (idempotentReplay) {
    return {
      status: 202,
      body: {
        ok: true,
        idempotentReplay: true,
        messageId: message.id,
        sessionId: session.id,
        runId: run.id,
        correlationId: run.id,
        agentId: agent.id,
        agentName: agent.botName,
      },
    };
  }
  dispatchRun(deps, session, message, run);
  return {
    status: 202,
    body: {
      ok: true,
      messageId: message.id,
      sessionId: session.id,
      runId: run.id,
      correlationId: run.id,
      agentId: agent.id,
      agentName: agent.botName,
    },
  };
}

function dispatchRun(
  deps: MessageRouteDeps,
  session: MessageSession,
  message: ChatMessage,
  run: ChatRun,
  notification?: 'result' | 'error',
): void {
  deps.events.publish({
    type: 'message.created',
    roomId: session.roomId,
    agentRef: run.targetAgentRef,
    messageId: message.id,
    runId: run.id,
    correlationId: run.id,
    payload: { sessionId: session.id },
  });
  deps.events.publish({
    type: 'run.available',
    roomId: session.roomId,
    agentRef: run.targetAgentRef,
    messageId: message.id,
    runId: run.id,
    correlationId: run.id,
    payload: { sessionId: session.id },
  });
  deps.deliverRun?.({
    id: run.id,
    conversationId: session.roomId!,
    triggerMessageId: message.id,
    targetAgentRef: run.targetAgentRef,
    prompt: message.content,
    engine: run.engine,
    model: run.model,
    presentation: run.presentation,
    ...(notification ? { notification } : {}),
  });
}

export function deliverRunResultToSenderSession(deps: MessageRouteDeps, run: ChatRun, event: ChatRunEvent): void {
  if (event.runId !== run.id || (event.kind !== 'complete' && event.kind !== 'error')) return;
  if (run.presentation?.mode === 'origin-proxy') return;
  const trigger = deps.chat.getMessage(run.triggerMessageId);
  if (!trigger?.senderSessionId || trigger.senderKind !== 'user' || trigger.conversationId !== run.conversationId)
    return;
  let session = deps.messages.getSession(trigger.senderSessionId);
  if (!session || session.roomId === run.conversationId) return;
  const senderAgent = deps.agents.getById(session.agentId);
  if (!senderAgent || (senderAgent.ownerName || senderAgent.botName).toLowerCase() !== trigger.senderRef) return;
  if (
    session.roomId &&
    (!deps.chat.hasParticipant(session.roomId, 'agent', senderAgent.botName) ||
      !deps.chat.hasParticipant(session.roomId, 'user', trigger.senderRef))
  )
    return;
  const key = `run-result:${run.id}`;
  if (deps.chat.getRunByIdempotency(trigger.senderRef, key)) return;
  const finalMessage = run.finalMessageId ? deps.chat.getMessage(run.finalMessageId) : null;
  const raw =
    event.kind === 'error' ? run.error || event.payload.error : finalMessage?.content || event.payload.content;
  const collapsed = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const excerpt =
    event.kind === 'error' && typeof raw === 'string'
      ? raw
      : collapsed.length > 800
        ? `${collapsed.slice(0, 800)}…`
        : collapsed;
  const text = [
    `[Agent Bus reply] ${run.targetAgentRef} ${event.kind === 'error' ? 'failed' : 'completed'} your task (run ${run.id}): ${excerpt || '(no text result)'}`,
    `Read the full run events: curl -H "Authorization: Bearer $METABOT_CORE_TOKEN" "\${METABOT_CORE_URL:-http://127.0.0.1:9200}/api/chat/runs/${run.id}/events"`,
    'Continue related work if appropriate; no reply is required for unrelated results.',
  ].join('\n\n');
  if (!session.roomId) {
    const room = deps.chat.createConversation({
      kind: 'dm',
      title: session.title || senderAgent.botName,
      createdBy: trigger.senderRef,
      participants: [{ kind: 'agent', ref: senderAgent.botName }],
    });
    session = deps.messages.ensureSession({
      agentId: senderAgent.id,
      agentName: senderAgent.botName,
      id: session.id,
      roomId: room.id,
    });
  }
  deps.chat.ensureParticipantUnchecked(session.roomId!, { kind: 'user', ref: trigger.senderRef });
  const presentation: ChatRunPresentation | undefined =
    session.transportPlatform === 'feishu' && isFeishuChatId(session.transportChatId || '')
      ? {
          mode: 'child-direct',
          chatId: session.transportChatId!,
          targetAgentRef: senderAgent.botName,
          requestedBy: run.targetAgentRef,
        }
      : undefined;
  const notice = deps.chat.appendMessageAndCreateRun(
    {
      conversationId: session.roomId!,
      kind: 'system',
      senderKind: 'user',
      senderRef: trigger.senderRef,
      senderDisplayName: run.targetAgentRef,
      content: text,
      mentionedAgentRefs: [],
    },
    {
      conversationId: session.roomId!,
      targetAgentRef: senderAgent.botName,
      idempotencyOwner: trigger.senderRef,
      idempotencyKey: key,
      presentation,
    },
  );
  if (!notice.idempotentReplay)
    dispatchRun(deps, session, notice.message, notice.run, event.kind === 'error' ? 'error' : 'result');
}

export function ackMessage(deps: MessageRouteDeps, id: string, cred: Credential): RouteResult {
  const canonical = deps.chat.getMessage(id);
  if (canonical) {
    const run = deps.chat.getRunByTriggerMessageId(id);
    if (!run) return err(409, 'message_not_bus_run');
    const agent = deps.agents.getByName(run.targetAgentRef);
    if (!agent) return err(404, 'agent_not_found');
    if (cred.role !== 'admin' && agent.ownerCredentialId !== cred.id && agent.ownerName !== cred.ownerName)
      return err(403, 'message_ack_ownership_required');
    const session = deps.messages.findSessionByRoom(agent.id, run.conversationId);
    const deliveryStatus = run.status === 'queued' ? 'pending' : 'acked';
    return {
      status: 200,
      body: {
        ok: true,
        canonical: true,
        message: {
          id: canonical.id,
          agentId: agent.id,
          sessionId: session?.id,
          senderAgentId: canonical.senderRef,
          senderSessionId: canonical.senderSessionId,
          text: canonical.content,
          replyTo: canonical.replyTo,
          createdAt: canonical.createdAt,
          status: deliveryStatus,
        },
        runId: run.id,
        deliveryStatus: run.status,
      },
    };
  }
  const legacy = deps.messages.getMessage(id);
  if (!legacy) return err(404, 'message_not_found');
  const agent = deps.agents.getById(legacy.agentId);
  if (agent && cred.role !== 'admin' && agent.ownerCredentialId !== cred.id && agent.ownerName !== cred.ownerName)
    return err(403, 'message_ack_ownership_required');
  const updated = deps.messages.ackMessage(id)!;
  return { status: 200, body: { ok: true, legacy: true, message: updated } };
}

export function streamMessages(
  deps: MessageRouteDeps,
  query: URLSearchParams,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cred: Credential,
): RouteResult | void {
  const ref = query.get('agentId') || query.get('agent') || '';
  const agent = resolveAgent(deps.agents, ref, cred);
  if (!agent) return err(404, 'agent_not_found');
  const sessionId = query.get('sessionId')?.trim() || '';
  if (sessionId) {
    const session = deps.messages.getSession(sessionId);
    if (!session || session.agentId !== agent.id || !canAccessSession(deps, session, agent, cred))
      return err(404, 'session_not_found');
  }
  deps.events.subscribe(req, res, (event) => {
    if (event.agentRef !== agent.botName) return false;
    const session =
      typeof event.payload?.sessionId === 'string'
        ? deps.messages.getSession(event.payload.sessionId)
        : event.roomId
          ? deps.messages.findSessionByRoom(agent.id, event.roomId)
          : null;
    return (
      !!session &&
      session.agentId === agent.id &&
      (!sessionId || session.id === sessionId) &&
      canAccessSession(deps, session, agent, cred)
    );
  });
}
