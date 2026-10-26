import { useCallback, useEffect, useRef, useState } from 'react';
import { api as chatApi, type ChatMessage, type MessageSession } from '../../lib/api';

interface SessionOutgoingEntry {
  status: 'sending' | 'failed';
  text: string;
  error?: string;
}

export function mergeSessionHistory(
  current: ChatMessage[] | null,
  latest: ChatMessage[],
  pagedBack: boolean,
  retainedIds: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  const existing = current ?? [];
  const known = new Set<string>();
  const rows = pagedBack
    ? [...existing, ...latest]
    : [...latest, ...existing.filter((message) => message.id.startsWith('local-') || retainedIds.has(message.id))];
  return rows.filter((message) => {
    if (known.has(message.id)) return false;
    known.add(message.id);
    return true;
  });
}

export function BusSessionComposer({ onSend, disabled = false }: {
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft('');
  };
  return (
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea
        aria-label="Message"
        rows={3}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" disabled={disabled || !draft.trim()}>Send</button>
    </form>
  );
}

export function BusSessionHistoryView({ agent, sessionId, onBack }: {
  agent: string;
  sessionId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [oldestMessageId, setOldestMessageId] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<MessageSession['status'] | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [agentName, setAgentName] = useState(agent);
  const [outgoing, setOutgoing] = useState<Map<string, SessionOutgoingEntry>>(new Map());
  const generation = useRef(0);
  const pagedBack = useRef(false);
  const pagingBusy = useRef(false);
  const roomId = useRef<string | null>(null);
  const retainedIds = useRef(new Set<string>());
  const deliveries = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScrolled = useRef(false);
  const stickToBottom = useRef(false);
  const previousScrollHeight = useRef<number | null>(null);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    let polling = false;
    setMessages(null);
    setHasMore(false);
    setOldestMessageId(null);
    setLoadingEarlier(false);
    setError(null);
    setStatus(null);
    setTitle(null);
    setAgentName(agent);
    setOutgoing(new Map());
    pagedBack.current = false;
    pagingBusy.current = false;
    roomId.current = null;
    retainedIds.current.clear();
    deliveries.current.clear();
    initialScrolled.current = false;
    stickToBottom.current = false;
    previousScrollHeight.current = null;

    const loadLatest = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await chatApi.listSessionHistory(sessionId, { limit: 50 });
        if (generation.current !== requestGeneration) return;
        roomId.current = result.roomId;
        setStatus(result.sessionStatus);
        setTitle(result.sessionTitle);
        setAgentName(result.agentName || agent);
        setError(null);
        const keepHistory = pagedBack.current;
        const retained = new Set(retainedIds.current);
        setMessages((current) => mergeSessionHistory(current, result.messages, keepHistory, retained));
        for (const message of result.messages) retainedIds.current.delete(message.id);
        if (!keepHistory) {
          setHasMore(result.hasMore);
          setOldestMessageId(result.oldestMessageId);
        }
      } catch {
        if (generation.current === requestGeneration) setError('会话历史加载失败');
      } finally {
        polling = false;
      }
    };

    void loadLatest();
    const timer = setInterval(() => void loadLatest(), 10_000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [agent, sessionId]);

  const loadEarlier = useCallback(async () => {
    if (!hasMore || !oldestMessageId || pagingBusy.current) return;
    const requestGeneration = generation.current;
    pagingBusy.current = true;
    pagedBack.current = true;
    setLoadingEarlier(true);
    try {
      const result = await chatApi.listSessionHistory(sessionId, { limit: 50, before: oldestMessageId });
      if (generation.current !== requestGeneration) return;
      previousScrollHeight.current = scrollRef.current?.scrollHeight ?? null;
      setMessages((current) => mergeSessionHistory(result.messages, current ?? [], true));
      setHasMore(result.hasMore);
      setOldestMessageId(result.oldestMessageId);
      setError(null);
    } catch {
      if (generation.current === requestGeneration) setError('更早的消息加载失败');
    } finally {
      if (generation.current === requestGeneration) {
        pagingBusy.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [hasMore, oldestMessageId, sessionId]);

  const deliver = useCallback(async (localId: string, text: string) => {
    if (deliveries.current.has(localId)) return;
    const requestGeneration = generation.current;
    deliveries.current.add(localId);
    setOutgoing((current) => new Map(current).set(localId, { status: 'sending', text }));
    try {
      const result = await chatApi.sendSessionMessage({ agentId: agent, sessionId, message: text });
      if (generation.current !== requestGeneration) return;
      retainedIds.current.add(result.messageId);
      setOutgoing((current) => {
        const next = new Map(current);
        next.delete(localId);
        return next;
      });
      setMessages((current) => {
        const rows = current ?? [];
        const confirmed = rows.some((message) => message.id === result.messageId);
        return rows.flatMap((message) => message.id !== localId
          ? [message]
          : confirmed ? [] : [{ ...message, id: result.messageId }]);
      });
    } catch (failure) {
      if (generation.current !== requestGeneration) return;
      const detail = failure instanceof Error ? failure.message : 'send_failed';
      setOutgoing((current) => new Map(current).set(localId, { status: 'failed', text, error: detail }));
    } finally {
      if (generation.current === requestGeneration) deliveries.current.delete(localId);
    }
  }, [agent, sessionId]);

  const send = (text: string) => {
    const localId = `local-${crypto.randomUUID()}`;
    const message: ChatMessage = {
      id: localId,
      conversationId: roomId.current ?? '',
      kind: 'user',
      senderKind: 'user',
      senderRef: 'me',
      senderDisplayName: 'You',
      content: text,
      mentionedAgentRefs: [],
      runId: null,
      createdAt: new Date().toISOString(),
    };
    stickToBottom.current = true;
    setMessages((current) => [...(current ?? []), message]);
    void deliver(localId, text);
  };

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !messages) return;
    if (previousScrollHeight.current != null) {
      scroll.scrollTop += scroll.scrollHeight - previousScrollHeight.current;
      previousScrollHeight.current = null;
    } else if (!initialScrolled.current || stickToBottom.current) {
      scroll.scrollTop = scroll.scrollHeight;
      initialScrolled.current = true;
      stickToBottom.current = false;
    }
  }, [messages]);

  const statusLabel = status === 'online' ? '在线'
    : status === 'resumable' ? '可恢复' : status === 'provisioning' ? '初始化中' : '离线';

  return (
    <section className="content chat-page" aria-label="Bus session history">
      <header className="chat-thread-head">
        <button type="button" onClick={onBack} aria-label="返回会话列表">←</button>
        <h2>{agentName}</h2>
        <p>{title || `SESSION ${sessionId.slice(0, 8)}`} · {statusLabel}</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <div
        className="chat-timeline"
        ref={scrollRef}
        style={{ overflowY: 'auto', maxHeight: '65dvh' }}
        onScroll={() => {
          if (scrollRef.current && scrollRef.current.scrollTop < 48) void loadEarlier();
        }}
      >
        {hasMore && (
          <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
            {loadingEarlier ? '加载中…' : '加载更早消息'}
          </button>
        )}
        {!messages && !error && <p role="status">正在加载会话历史…</p>}
        {messages?.length === 0 && !error && <p>该会话暂无消息</p>}
        {messages?.map((message) => {
          const entry = outgoing.get(message.id);
          return (
            <article key={message.id} className={`chat-message ${message.kind}`}>
              <div className="chat-message-head">
                <span>{message.senderDisplayName || message.senderRef}</span>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
              </div>
              <div className="chat-message-body" style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
              {entry?.status === 'sending' && <small>发送中…</small>}
              {entry?.status === 'failed' && (
                <div role="alert">
                  <span>发送失败{entry.error ? ` · ${entry.error}` : ''}</span>
                  <button type="button" onClick={() => void deliver(message.id, entry.text)}>重试</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <BusSessionComposer key={`${agent}:${sessionId}`} disabled={status == null} onSend={send} />
    </section>
  );
}
