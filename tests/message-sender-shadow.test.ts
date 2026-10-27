import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';
import { feishuConversationId } from '../src/feishu/conversation.js';
import { withReplyContext } from '../src/bridge/reply-context.js';

const { execFile, existsSync } = vi.hoisted(() => ({ execFile: vi.fn(), existsSync: vi.fn(() => false) }));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execFile }) };
});

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync,
}));

function kit(domain = 'https://open.feishu.cn') {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { sender: new MessageSender({ domain } as any, logger as any), logger };
}

const threadMessage = {
  chatId: 'oc_chat', messageId: 'om_inbound', chatType: 'group', text: 'task', userId: 'ou_owner', rootMessageId: 'om_root',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('METABOT_SHADOW_USER_ACCESS_TOKEN', '');
  vi.stubEnv('LARK_CLI_PATH', '');
  existsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MessageSender Shadow CLI delivery', () => {
  it.each([
    { ok: true, data: { message_id: 'om_sent' } },
    { ok: true, data: { receipt: { message_id: 'om_sent' } } },
    { success: true, messageId: 'om_sent' },
  ])('accepts legacy and new receipts: %j', async (payload) => {
    execFile.mockResolvedValue({ stdout: JSON.stringify(payload) });
    vi.stubEnv('LARK_CLI_PATH', '/user-selected/lark-cli');
    const { sender } = kit();
    expect(await sender.sendTextAsUser('oc_chat', 'literal ; $(text)', 'shadow-key')).toBe('om_sent');
    expect(execFile).toHaveBeenCalledWith('/user-selected/lark-cli', [
      'im', '+messages-send', '--chat-id', 'oc_chat', '--as', 'user', '--text', 'literal ; $(text)', '--idempotency-key', 'shadow-key',
    ], expect.objectContaining({ timeout: 30_000 }));
  });

  it('resolves common CLI install locations without modifying the installation', async () => {
    existsSync.mockImplementation((candidate: unknown) => String(candidate).endsWith('/.npm-global/bin/lark-cli'));
    execFile.mockResolvedValue({ stdout: JSON.stringify({ success: true, messageId: 'om_sent' }) });
    await kit().sender.sendTextAsUser('oc_chat', 'next', 'shadow-key');
    expect(execFile.mock.calls[0][0]).toMatch(/\.npm-global\/bin\/lark-cli$/);
  });

  it('keeps encoded thread conversations inside the original thread', async () => {
    execFile.mockResolvedValue({ stdout: JSON.stringify({ success: true, messageId: 'om_sent' }) });
    const chatId = feishuConversationId(threadMessage);
    await kit().sender.sendTextAsUser(chatId, 'next', 'shadow-key');
    expect(execFile.mock.calls[0][1]).toEqual([
      'im', '+messages-reply', '--message-id', 'om_root', '--reply-in-thread', '--as', 'user', '--text', 'next', '--idempotency-key', 'shadow-key',
    ]);
  });

  it.each([
    {}, { ok: false, data: { message_id: 'om_sent' } }, { success: true }, { success: true, messageId: 123 },
  ])('rejects absent, failed or invalid receipts: %j', async (payload) => {
    execFile.mockResolvedValue({ stdout: JSON.stringify(payload) });
    expect(await kit().sender.sendTextAsUser('oc_chat', 'next', 'shadow-key')).toBeUndefined();
  });

  it('does not log CLI stdout/stderr or authorization details on failure', async () => {
    const { sender, logger } = kit();
    execFile.mockRejectedValue(new Error('sensitive stderr'));
    expect(await sender.sendTextAsUser('oc_chat', 'next', 'shadow-key')).toBeUndefined();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sensitive stderr');
  });
});

describe('MessageSender Shadow runtime token delivery', () => {
  it.each(['https://open.feishu.cn', 'https://open.larksuite.com'])('preserves the configured public API domain %s', async (domain) => {
    vi.stubEnv('METABOT_SHADOW_USER_ACCESS_TOKEN', 'test-only-runtime-token');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await kit(domain).sender.sendTextAsUser('oc_chat', 'next', 'shadow-key')).toBe('om_sent');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${domain}/open-apis/im/v1/messages?receive_id_type=chat_id`);
    const options = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toMatchObject({ receive_id: 'oc_chat', msg_type: 'text', content: '{"text":"next"}', uuid: expect.stringMatching(/^[a-f0-9]{50}$/) });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('preserves the triggering thread reply context', async () => {
    vi.stubEnv('METABOT_SHADOW_USER_ACCESS_TOKEN', 'test-only-runtime-token');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } })));
    vi.stubGlobal('fetch', fetchMock);
    const chatId = feishuConversationId(threadMessage);
    await withReplyContext({ ...threadMessage, chatId }, () => kit().sender.sendTextAsUser(chatId, 'next', 'shadow-key'));
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_inbound/reply');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reply_in_thread).toBe(true);
    expect(body.receive_id).toBeUndefined();
  });

  it('does not log token, API payload or thrown fetch details', async () => {
    vi.stubEnv('METABOT_SHADOW_USER_ACCESS_TOKEN', 'test-only-runtime-token');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 999, msg: 'sensitive message' }), { status: 403 }))
      .mockRejectedValueOnce(new Error('test-only-runtime-token'));
    vi.stubGlobal('fetch', fetchMock);
    const { sender, logger } = kit();
    expect(await sender.sendTextAsUser('oc_chat', 'next', 'shadow-key')).toBeUndefined();
    expect(await sender.sendTextAsUser('oc_chat', 'next', 'shadow-key')).toBeUndefined();
    const logs = JSON.stringify(logger.error.mock.calls);
    expect(logs).not.toContain('test-only-runtime-token');
    expect(logs).not.toContain('sensitive message');
    expect(execFile).not.toHaveBeenCalled();
  });
});
