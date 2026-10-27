import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.METABOT_CORE_TOKEN = 'mt_test_tok';
  process.env.METABOT_CORE_URL = 'https://example.test/core';
  process.env.HOME = '/tmp/metabot-cli-test-home-does-not-exist';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/send.js')> {
  vi.resetModules();
  return await import('../src/send.js');
}

describe('metabot send', () => {
  it('prints help without reading config or making requests', async () => {
    process.env.METABOT_CORE_TOKEN = '';
    process.env.METABOT_CORE_URL = '';
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['--help']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'metabot send - minimal durable Agent Bus message',
    );
  });

  it('posts a minimal message with an exact session', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://example.test/core/api/messages');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        agentId: 'superagent',
        message: 'hello',
        sessionId: 'session_1',
      });
      return new Response(JSON.stringify({ ok: true, messageId: 'msg_1', sessionId: 'session_1', runId: 'run_1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['superagent', 'hello', '--session', 'session_1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('"runId": "run_1"');
  });

  it('supports implicit and origin-proxy presentation modes', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, runId: `run_${bodies.length}` }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('METABOT_ORIGIN_CHAT', 'oc_origin_chat');
    vi.stubEnv('METABOT_ORIGIN_BOT', 'metabot');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['superagent', 'background only', '--implicit']);
    await mod.run(['superagent', 'run this']);
    await mod.run(['superagent', 'direct', '--child-direct']);

    expect(bodies).toEqual([
      { agentId: 'superagent', message: 'background only', presentationMode: 'implicit' },
      {
        agentId: 'superagent',
        message: 'run this',
        presentationMode: 'origin-proxy',
        originChatId: 'oc_origin_chat',
        originBotName: 'metabot',
      },
      { agentId: 'superagent', message: 'direct', presentationMode: 'child-direct' },
    ]);
  });

  it('lists sessions and reads history using encoded pagination queries', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ sessions: [], messages: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await importFresh();
    await mod.run(['sessions', 'agent/with space', '--limit', '3', '--offset', '2']);
    await mod.run(['history', 'session/?', '--limit', '5', '--before', 'message/&']);
    const list = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(list.pathname).toBe('/core/api/messages/sessions');
    expect(Object.fromEntries(list.searchParams)).toEqual({ agentId: 'agent/with space', limit: '3', offset: '2' });
    const history = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(history.pathname).toBe('/core/api/messages/history');
    expect(Object.fromEntries(history.searchParams)).toEqual({
      sessionId: 'session/?',
      limit: '5',
      before: 'message/&',
    });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer mt_test_tok' } });
  });

  it('prints session candidates on conflicts without partial success output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'session_required',
              sessions: [{ id: 's1', status: 'resumable', title: 'First task', updatedAt: 'now' }],
            }),
            { status: 409 },
          ),
      ),
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await importFresh();
    await expect(mod.run(['target', 'hello'])).rejects.toThrow('s1  resumable  now  First task');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('forwards sender-session and prioritizes implicit over child-direct', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await importFresh();
    await mod.run(['target', 'hello', '--sender-session', 'sender-live', '--implicit', '--child-direct']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      agentId: 'target',
      message: 'hello',
      senderSessionId: 'sender-live',
      presentationMode: 'implicit',
    });
  });

  it('preserves the public local Core default for session reads', async () => {
    delete process.env.METABOT_CORE_URL;
    delete process.env.METABOT_CORE_AGENT_BUS_URL;
    const fetchMock = vi.fn(async (_url: unknown) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await importFresh();
    await mod.run(['sessions', 'target']);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:9200/api/messages/sessions?agentId=target');
  });

  it.each(['sessions', 'history'])('reports %s request errors and requires an identifier', async (command) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not authorized', { status: 403 })),
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await importFresh();
    await expect(mod.run([command])).rejects.toThrow('required');
    await expect(mod.run([command, 'identifier'])).rejects.toThrow('403: not authorized');
    expect(stdout).not.toHaveBeenCalled();
  });
});
