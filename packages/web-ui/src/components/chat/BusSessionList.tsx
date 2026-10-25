import { useCallback, useEffect, useRef, useState } from 'react';
import { api as chatApi, type MessageSession } from '../../lib/api';
import { formatRelative } from '../../lib/format';

interface Props {
  agent: string;
  onBack?: () => void;
  onSelect: (session: MessageSession) => void;
  onNewSession: () => void;
}

const STATUS_LABEL: Record<MessageSession['status'], string> = {
  online: '在线',
  resumable: '可恢复',
  offline: '离线',
  provisioning: '初始化中',
};

export default function BusSessionList({ agent, onBack, onSelect, onNewSession }: Props) {
  const [sessions, setSessions] = useState<MessageSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async (offset: number, append: boolean, requestGeneration: number) => {
    if (busy.current) return;
    busy.current = true;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const result = await chatApi.listAgentSessions(agent, { limit: 30, offset });
      if (generation.current !== requestGeneration) return;
      setSessions((current) => {
        const rows = append ? [...current, ...result.sessions] : result.sessions;
        return [...new Map(rows.map((session) => [session.id, session])).values()];
      });
      setNextOffset(result.hasMore ? result.nextOffset : null);
      setError(null);
    } catch {
      if (generation.current === requestGeneration) setError('会话列表加载失败');
    } finally {
      if (generation.current === requestGeneration) {
        busy.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [agent]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    busy.current = false;
    setSessions([]);
    setNextOffset(null);
    setLoadingMore(false);
    setError(null);
    void load(0, false, requestGeneration);
    return () => { generation.current++; };
  }, [load]);

  return (
    <section className="content chat-page" aria-label="Bus sessions">
      <header className="chat-thread-head">
        {onBack && <button type="button" onClick={onBack} aria-label="返回会话列表">←</button>}
        <h2>{agent} · Bus sessions</h2>
        <button type="button" onClick={onNewSession}>发起新会话</button>
      </header>
      {loading && <p role="status">正在加载会话…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && sessions.length === 0 && (
        <div className="chat-empty-state">
          <p>暂无会话</p>
          <button type="button" onClick={onNewSession}>发起新会话</button>
        </div>
      )}
      <ul className="chat-conversation-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <button type="button" className="chat-conversation-row" onClick={() => onSelect(session)}>
              <span className="chat-conversation-title">{session.title?.trim() || session.id.slice(0, 8)}</span>
              <span className="chat-conversation-meta">
                <span>{STATUS_LABEL[session.status] || STATUS_LABEL.offline}</span>
                {session.provider && <span>{session.provider}</span>}
                <time dateTime={session.updatedAt}>{formatRelative(session.updatedAt)}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!loading && error && nextOffset == null && sessions.length === 0 && (
        <button type="button" onClick={() => void load(0, false, generation.current)}>重试</button>
      )}
      {nextOffset != null && (
        <button type="button" disabled={loadingMore} onClick={() => void load(nextOffset, true, generation.current)}>
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
    </section>
  );
}
