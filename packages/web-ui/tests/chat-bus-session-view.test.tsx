import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatMessage } from '../src/lib/api';
import { Chat } from '../src/routes/chat';
import BusSessionList from '../src/components/chat/BusSessionList';
import { BusSessionComposer, BusSessionHistoryView, mergeSessionHistory } from '../src/components/chat/BusSessionHistoryView';

afterEach(() => vi.restoreAllMocks());

function message(id: string, content = `msg ${id}`): ChatMessage {
  return {
    id, content, conversationId: 'room-1', kind: 'assistant', senderKind: 'agent',
    senderRef: 'bot', senderDisplayName: 'bot', mentionedAgentRefs: [], runId: null,
    createdAt: '2026-10-01T00:00:00Z',
  };
}

describe('executable poll-safe pagination state', () => {
  it('replaces the latest page before pagination, preserving pending local bubbles', () => {
    expect(mergeSessionHistory([message('old'), message('local-1')], [message('m1')], false).map((row) => row.id))
      .toEqual(['m1', 'local-1']);
  });

  it('preserves earlier pages across repeated polls without reordering existing messages', () => {
    const current = [message('m0'), message('m1')];
    const polled = mergeSessionHistory(current, [message('m1'), message('m2')], true);
    const next = mergeSessionHistory(polled, [message('m2'), message('m3')], true);
    expect(next.map((row) => row.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(mergeSessionHistory(next, [message('m3')], true)).toEqual(next);
    expect(current.map((row) => row.id)).toEqual(['m0', 'm1']);
  });

  it('keeps acknowledged sends through stale polls and deduplicates the eventual server copy', () => {
    const current = [message('m1'), message('acknowledged')];
    const merged = mergeSessionHistory(current, [message('m1')], false, new Set(['acknowledged']));
    expect(merged.map((row) => row.id)).toEqual(['m1', 'acknowledged']);
    expect(mergeSessionHistory(merged, [message('m1'), message('acknowledged')], false).map((row) => row.id))
      .toEqual(['m1', 'acknowledged']);
  });

  it('merges earlier history after an in-flight poll without duplicates or lost tail messages', () => {
    const polled = mergeSessionHistory([message('m2')], [message('m2'), message('m3')], true);
    const prepended = mergeSessionHistory([message('m0'), message('m1'), message('m2')], polled, true);
    expect(mergeSessionHistory(prepended, [message('m3'), message('m4')], true).map((row) => row.id))
      .toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('keeps failed and sending optimistic bubbles while loading additional history', () => {
    const current = [message('m2'), message('local-failed'), message('local-sending')];
    const earlier = mergeSessionHistory([message('m1')], current, true);
    expect(mergeSessionHistory(earlier, [message('m2'), message('m3')], true).map((row) => row.id))
      .toEqual(['m1', 'm2', 'local-failed', 'local-sending', 'm3']);
  });

  it('handles initial, empty, and duplicate pages', () => {
    expect(mergeSessionHistory(null, [], false)).toEqual([]);
    expect(mergeSessionHistory(null, [message('m1'), message('m1')], true).map((row) => row.id)).toEqual(['m1']);
    expect(mergeSessionHistory([message('m1')], [], true).map((row) => row.id)).toEqual(['m1']);
  });
});

describe('public rendered Chat without new DOM dependencies', () => {
  it('renders the Bus list without auto-creating a DM or mounting the conversation view', () => {
    const findDm = vi.spyOn(api, 'findOrCreateAgentDm');
    const markup = renderToStaticMarkup(<StaticRouter location="/chat?agent=bot"><Chat /></StaticRouter>);
    expect(markup).toContain('Bus sessions');
    expect(markup).toContain('发起新会话');
    expect(markup).not.toContain('chat-main');
    expect(findDm).not.toHaveBeenCalled();
  });

  it('renders session history from the actual public route', () => {
    const markup = renderToStaticMarkup(<StaticRouter location="/chat?agent=bot&session=abcdefgh-1"><Chat /></StaticRouter>);
    expect(markup).toContain('Bus session history');
    expect(markup).toContain('SESSION abcdefgh');
    expect(markup).not.toContain('chat-main');
  });

  it('preserves the personal conversation UI and c= deep links', () => {
    const markup = renderToStaticMarkup(<StaticRouter location="/chat?c=my-conversation"><Chat /></StaticRouter>);
    expect(markup).toContain('chat-main');
    expect(markup).not.toContain('Bus session history');
  });

  it('renders an accessible composer disabled until session access is resolved', () => {
    const markup = renderToStaticMarkup(<BusSessionHistoryView agent="bot" sessionId="s1" onBack={() => undefined} />);
    expect(markup).toContain('aria-label="Message"');
    expect(markup).toMatch(/<textarea[^>]*disabled=""/);
    expect(markup).toContain('返回会话列表');
    expect(renderToStaticMarkup(<BusSessionComposer onSend={() => undefined} />)).toContain('type="submit" disabled=""');
  });

  it('escapes agent names instead of injecting markup', () => {
    const markup = renderToStaticMarkup(<BusSessionList agent="<script>bad</script>" onSelect={() => undefined} onNewSession={() => undefined} />);
    expect(markup).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
  });
});

describe('public integration contracts', () => {
  it('guards pagination before requesting older history and ignores stale session responses', () => {
    const history = readFileSync(new URL('../src/components/chat/BusSessionHistoryView.tsx', import.meta.url), 'utf8');
    const pagingStart = history.indexOf('pagedBack.current = true;');
    const request = history.indexOf('chatApi.listSessionHistory(sessionId, { limit: 50, before: oldestMessageId })');
    expect(pagingStart).toBeGreaterThan(0);
    expect(pagingStart).toBeLessThan(request);
    expect(history).toContain('if (!keepHistory)');
    expect(history).toContain('generation.current !== requestGeneration');
    expect(history).toContain('clearInterval(timer)');
    expect(history).toContain('event.nativeEvent.isComposing');
  });

  it('uses the actual public route and auth without prototype or private identity dependencies', () => {
    const source = [
      '../src/routes/chat.tsx', '../src/lib/api.ts',
      '../src/components/chat/BusSessionList.tsx', '../src/components/chat/BusSessionHistoryView.tsx',
    ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
    for (const excluded of ['/oauth2/', 'X-Forwarded-Email', '@/data/', 'prototype/', 'feilian', 'Cursor']) {
      expect(source).not.toContain(excluded);
    }
    expect(source).toContain('setParams({ c: conversation.id })');
    expect(source).toContain("credentials: 'same-origin'");
  });
});
