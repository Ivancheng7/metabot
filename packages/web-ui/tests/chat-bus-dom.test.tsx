import { createRequire } from 'node:module';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatMessage, type SessionHistoryResult } from '../src/lib/api';
import { BusSessionComposer, BusSessionHistoryView } from '../src/components/chat/BusSessionHistoryView';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
let root: Root;
let createRoot: typeof import('react-dom/client').createRoot;
let container: HTMLDivElement;
let dom: InstanceType<typeof JSDOM>;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function message(id: string): ChatMessage {
  return {
    id, content: `msg ${id}`, conversationId: 'room-1', kind: 'assistant', senderKind: 'agent',
    senderRef: 'bot', senderDisplayName: 'bot', mentionedAgentRefs: [], runId: null,
    createdAt: '2026-10-01T00:00:00Z',
  };
}

function page(messages: ChatMessage[], overrides: Partial<SessionHistoryResult> = {}): SessionHistoryResult {
  return {
    sessionId: 's1', agentId: 'bot', agentName: 'bot', roomId: 'room-1', sessionStatus: 'online',
    sessionTitle: 'Readable title', messages, hasMore: false, oldestMessageId: messages[0]?.id ?? null,
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

async function type(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

describe('Bus composer DOM interactions', () => {
  it('sends trimmed drafts and clears the input', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<BusSessionComposer onSend={onSend} />));
    await type('  hello  ');
    await click('Send');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  it('sends on Enter but not Shift+Enter or IME composition', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<BusSessionComposer onSend={onSend} />));
    await type('hello');
    const textarea = container.querySelector('textarea')!;
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      await act(async () => {
        textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }));
      });
    }
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('hello');
  });
});

describe('Bus history asynchronous state', () => {
  it('keeps failed bubbles and retries through the authenticated Bus API', async () => {
    vi.spyOn(api, 'listSessionHistory').mockResolvedValue(page([]));
    const send = vi.spyOn(api, 'sendSessionMessage').mockRejectedValueOnce(new Error('session_offline')).mockResolvedValueOnce({
      ok: true, messageId: 'm2', sessionId: 's1', runId: 'r1', correlationId: 'r1', agentId: 'bot', agentName: 'bot',
    });
    await act(async () => root.render(<BusSessionHistoryView agent="bot" sessionId="s1" onBack={() => undefined} />));
    expect(container.textContent).toContain('Readable title · 在线');
    await type('hello');
    await click('Send');
    expect(container.textContent).toContain('发送失败 · session_offline');
    await click('重试');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ agentId: 'bot', sessionId: 's1', message: 'hello' });
    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(container.textContent).not.toContain('发送失败');
  });

  it('does not reset pagination when polling finishes during an earlier-page request', async () => {
    vi.useFakeTimers();
    const earlier = deferred<SessionHistoryResult>();
    const history = vi.spyOn(api, 'listSessionHistory')
      .mockResolvedValueOnce(page([message('m2')], { hasMore: true }))
      .mockImplementationOnce(() => earlier.promise)
      .mockResolvedValueOnce(page([message('m2'), message('m3')], { oldestMessageId: 'm2', hasMore: true }))
      .mockResolvedValueOnce(page([message('m2'), message('m3'), message('m4')], { oldestMessageId: 'm2', hasMore: true }));
    await act(async () => root.render(<BusSessionHistoryView agent="bot" sessionId="s1" onBack={() => undefined} />));
    await click('加载更早消息');
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => earlier.resolve(page([message('m1')], { hasMore: false })));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect([...container.querySelectorAll('.chat-message-body')].map((element) => element.textContent))
      .toEqual(['msg m1', 'msg m2', 'msg m3', 'msg m4']);
    expect(history.mock.calls[1]).toEqual(['s1', { limit: 50, before: 'm2' }]);
    expect(container.textContent).not.toContain('加载更早消息');
  });

  it('ignores old-session responses after navigation and stops polling on unmount', async () => {
    vi.useFakeTimers();
    const oldPage = deferred<SessionHistoryResult>();
    const history = vi.spyOn(api, 'listSessionHistory').mockReturnValueOnce(oldPage.promise)
      .mockResolvedValue(page([message('new')], { sessionId: 's2' }));
    await act(async () => root.render(<BusSessionHistoryView agent="bot" sessionId="s1" onBack={() => undefined} />));
    await act(async () => root.render(<BusSessionHistoryView agent="bot" sessionId="s2" onBack={() => undefined} />));
    await act(async () => oldPage.resolve(page([message('old')])));
    expect(container.textContent).toContain('msg new');
    expect(container.textContent).not.toContain('msg old');
    await act(async () => root.render(<div />));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(history).toHaveBeenCalledTimes(2);
  });
});
