import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api as chatApi } from '../src/lib/api';
import { ApiError } from '../src/lib/api';
import { API_TOKEN_STORAGE_KEY, AUTH_REQUIRED_EVENT } from '../src/lib/auth';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Bus session API with personal token auth', () => {
  it('encodes agent names and pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sessions: [], hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    await chatApi.listAgentSessions('bot & helper', { limit: 30, offset: 60 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/messages/sessions?agentId=bot+%26+helper&limit=30&offset=60');
  });

  it('encodes history cursors and session IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ messages: [], hasMore: true, oldestMessageId: 'm9' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await chatApi.listSessionHistory('s/1', { limit: 50, before: 'm&10' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/messages/history?sessionId=s%2F1&limit=50&before=m%2610');
    expect(result.oldestMessageId).toBe('m9');
  });

  it.each(['list', 'history', 'send'])('uses the existing browser credential for %s', async (method) => {
    storage.set(API_TOKEN_STORAGE_KEY, 'personal-test-token');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, messageId: 'm1' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    if (method === 'list') await chatApi.listAgentSessions('bot');
    else if (method === 'history') await chatApi.listSessionHistory('s1');
    else await chatApi.sendSessionMessage({ agentId: 'bot', sessionId: 's1', message: 'hello' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/api\/messages/);
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer personal-test-token' });
    if (method === 'send') {
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init.body))).toEqual({ agentId: 'bot', sessionId: 's1', message: 'hello' });
    }
  });

  it('clears rejected credentials and requests local login without redirecting', async () => {
    storage.set(API_TOKEN_STORAGE_KEY, 'expired-test-token');
    const dispatchEvent = vi.fn();
    const location = { href: '/chat?agent=bot&session=s1' };
    vi.stubGlobal('window', { dispatchEvent, location });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 401 })));
    await expect(chatApi.listSessionHistory('s1')).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(storage.has(API_TOKEN_STORAGE_KEY)).toBe(false);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(AUTH_REQUIRED_EVENT);
    expect(location.href).toBe('/chat?agent=bot&session=s1');
  });

  it('does not clear credentials on an authorization denial', async () => {
    storage.set(API_TOKEN_STORAGE_KEY, 'personal-test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 })));
    await expect(chatApi.listSessionHistory('s1')).rejects.toBeInstanceOf(ApiError);
    expect(storage.get(API_TOKEN_STORAGE_KEY)).toBe('personal-test-token');
  });

  it('handles non-JSON errors without hiding the HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503, statusText: 'Unavailable' })));
    await expect(chatApi.listAgentSessions('bot')).rejects.toMatchObject({ status: 503, code: 'Unavailable' });
  });
});
