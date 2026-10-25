import { afterEach, describe, expect, it } from 'vitest';
import { call, startTestServer, type ServerKit } from './helpers.js';

let kit: ServerKit | undefined;
afterEach(async () => {
  await kit?.cleanup();
  kit = undefined;
});

async function issue(k: ServerKit, botName: string, ownerName = botName) {
  const r = await call(k.baseUrl, 'POST', '/admin/credentials/issue', k.adminToken, {
    botName,
    ownerName,
    role: 'member',
  });
  expect(r.status).toBe(201);
  return { token: r.body.token as string, credentialId: r.body.credential.id as string };
}

async function busFixture() {
  kit = await startTestServer('session-bus');
  const sender = await issue(kit, 'sender', 'sender@example.com');
  const owner = await issue(kit, 'target-owner', 'target@example.com');
  const target = kit.handle.agentStore.register({
    botName: 'target',
    url: 'inbox:',
    ownerCredentialId: owner.credentialId,
    ownerName: 'target@example.com',
  });
  const senderAgent = kit.handle.agentStore.register({
    botName: 'sender',
    url: 'inbox:',
    ownerCredentialId: sender.credentialId,
    ownerName: 'sender@example.com',
  });
  return { server: kit, sender, owner, target, senderAgent };
}

describe('minimal message protocol', () => {
  it('derives titles and paginates history in insertion order', async () => {
    const { server, sender, target } = await busFixture();
    const text = '  First\n   message ' + 'x'.repeat(60);
    const first = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: text,
    });
    expect(first.status).toBe(202);
    expect(server.handle.messageStore.getSession(first.body.sessionId)?.title).toBe(
      text.replace(/\s+/g, ' ').trim().slice(0, 40),
    );
    const second = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'second',
    });
    const third = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'third',
    });
    const page = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${first.body.sessionId}&limit=2`,
      sender.token,
    );
    expect(page.status).toBe(200);
    expect(page.body.messages.map((message: { id: string }) => message.id)).toEqual([
      second.body.messageId,
      third.body.messageId,
    ]);
    expect(page.body).toMatchObject({ hasMore: true, oldestMessageId: second.body.messageId });
    const older = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${first.body.sessionId}&limit=1&before=${second.body.messageId}`,
      sender.token,
    );
    expect(older.body.messages.map((message: { id: string }) => message.id)).toEqual([first.body.messageId]);
    expect(older.body.hasMore).toBe(false);
    server.handle.db.prepare('UPDATE message_sessions SET title = NULL WHERE id = ?').run(first.body.sessionId);
    const previousTime = server.handle.messageStore.getSession(first.body.sessionId)!.updatedAt;
    const list = await call(server.baseUrl, 'GET', `/api/messages/sessions?agentId=${target.id}&limit=1`, sender.token);
    expect(list.body.sessions[0].title).toBe(text.replace(/\s+/g, ' ').trim().slice(0, 40));
    expect(server.handle.messageStore.getSession(first.body.sessionId)!.updatedAt).toBe(previousTime);
    server.handle.messageStore.setSessionTitle(first.body.sessionId, 'Custom title');
    const titled = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${first.body.sessionId}&limit=Infinity`,
      sender.token,
    );
    expect(titled.body).toMatchObject({ sessionTitle: 'Custom title', limit: 20, hasMore: false });
  });

  it('does not grant session access merely because an agent is visible', async () => {
    const { server, sender, owner, target } = await busFixture();
    const stranger = await issue(server, 'stranger', 'stranger@example.com');
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'private conversation',
    });
    for (const route of [`/api/messages/sessions?agentId=${target.id}`, `/api/agents/${target.id}/sessions`]) {
      const listed = await call(server.baseUrl, 'GET', route, stranger.token);
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ sessions: [], total: 0, hasMore: false });
      expect(JSON.stringify(listed.body)).not.toContain('private conversation');
    }
    const history = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${sent.body.sessionId}`,
      stranger.token,
    );
    expect(history.status).toBe(404);
    expect(
      (
        await call(
          server.baseUrl,
          'GET',
          `/api/messages/stream?agentId=${target.id}&sessionId=${sent.body.sessionId}`,
          stranger.token,
        )
      ).status,
    ).toBe(404);
    const denied = await call(server.baseUrl, 'POST', '/api/messages', stranger.token, {
      agentId: target.id,
      sessionId: sent.body.sessionId,
      message: 'inject',
    });
    expect(denied.status).toBe(404);
    const roomId = server.handle.messageStore.getSession(sent.body.sessionId)!.roomId!;
    expect(server.handle.chatStore.hasParticipant(roomId, 'user', 'stranger@example.com')).toBe(false);
    const own = await call(server.baseUrl, 'POST', '/api/messages', stranger.token, {
      agentId: target.id,
      message: 'separate context',
    });
    expect(own.status).toBe(202);
    expect(own.body.sessionId).not.toBe(sent.body.sessionId);
    const joined = await call(server.baseUrl, 'POST', '/api/messages', owner.token, {
      agentId: target.id,
      sessionId: sent.body.sessionId,
      message: 'owner follow-up',
    });
    expect(joined.status).toBe(202);
    expect(server.handle.chatStore.hasParticipant(roomId, 'user', 'target@example.com')).toBe(true);
    server.handle.agentStore.setVisibility('target', false);
    expect(
      (await call(server.baseUrl, 'GET', `/api/messages/history?sessionId=${sent.body.sessionId}`, sender.token))
        .status,
    ).toBe(404);
    expect((await call(server.baseUrl, 'GET', '/api/messages/history?sessionId=missing', sender.token)).status).toBe(
      404,
    );
  });

  it('filters authorization before pagination and session selection', async () => {
    const { server, sender, owner, target } = await busFixture();
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'mine',
    });
    server.handle.messageStore.touchSession(sent.body.sessionId, 'resumable');
    for (let index = 0; index < 105; index++) {
      const room = server.handle.chatStore.createConversation({
        kind: 'dm',
        createdBy: 'other@example.com',
        participants: [{ kind: 'agent', ref: 'target' }],
      });
      server.handle.messageStore.ensureSession({
        id: `other-${index}`,
        agentId: target.id,
        agentName: 'target',
        roomId: room.id,
        status: 'resumable',
      });
    }
    const listed = await call(
      server.baseUrl,
      'GET',
      `/api/messages/sessions?agentId=${target.id}&limit=1`,
      sender.token,
    );
    expect(listed.body).toMatchObject({ total: 1, hasMore: false, nextOffset: null });
    const reused = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'reuse mine',
    });
    expect(reused.status).toBe(202);
    expect(reused.body.sessionId).toBe(sent.body.sessionId);
    const ambiguous = await call(server.baseUrl, 'POST', '/api/messages', owner.token, {
      agentId: target.id,
      message: 'choose',
    });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toBe('session_required');
    expect(ambiguous.body.sessions).toHaveLength(100);
  });

  it('rejects return-session and registration injection before creating runs', async () => {
    const { server, sender, owner, target, senderAgent } = await busFixture();
    const room = server.handle.chatStore.createConversation({
      kind: 'dm',
      createdBy: 'sender@example.com',
      participants: [{ kind: 'agent', ref: 'target' }],
    });
    const foreign = server.handle.messageStore.ensureSession({
      id: 'foreign',
      agentId: target.id,
      agentName: 'target',
      roomId: room.id,
    });
    for (const sessionId of [foreign.id, 'missing']) {
      const rejected = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
        agentId: target.id,
        senderSessionId: sessionId,
        message: 'inject return',
      });
      expect(rejected.status).toBe(403);
      expect(rejected.body.error).toBe('sender_session_ownership_required');
    }
    const otherRoom = server.handle.chatStore.createConversation({
      kind: 'dm',
      createdBy: 'other@example.com',
      participants: [{ kind: 'agent', ref: 'sender' }],
    });
    server.handle.messageStore.ensureSession({
      id: 'owned-but-other-user',
      agentId: senderAgent.id,
      agentName: 'sender',
      roomId: otherRoom.id,
    });
    expect(
      (
        await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
          agentId: target.id,
          message: 'inject',
          senderSessionId: 'owned-but-other-user',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(server.baseUrl, 'POST', '/api/messages/sessions', sender.token, {
          agentId: senderAgent.id,
          roomId: room.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(server.baseUrl, 'POST', '/api/messages/sessions', sender.token, {
          agentId: senderAgent.id,
          sessionId: foreign.id,
        })
      ).status,
    ).toBe(409);
    const secondRoom = server.handle.chatStore.createConversation({
      kind: 'dm',
      createdBy: 'target@example.com',
      participants: [{ kind: 'agent', ref: 'target' }],
    });
    expect(
      (
        await call(server.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
          agentId: target.id,
          sessionId: foreign.id,
          roomId: secondRoom.id,
        })
      ).status,
    ).toBe(409);
    expect((server.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(
      0,
    );
  });

  it.each(['complete', 'error'] as const)(
    'returns %s results through Core dispatch, once and without loops',
    async (kind) => {
      const { server, sender, owner, target, senderAgent } = await busFixture();
      server.handle.messageStore.ensureSession({
        id: 'sender-live',
        agentId: senderAgent.id,
        agentName: 'sender',
        status: 'offline',
        transportPlatform: 'feishu',
        transportChatId: 'oc_sender_chat',
      });
      const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
        agentId: target.id,
        message: 'do work',
        senderSessionId: 'sender-live',
      });
      expect(sent.status).toBe(202);
      const result = `${'long result '.repeat(100)}\nfull final detail`;
      const body = { seq: 1, kind, payload: kind === 'complete' ? { finalContent: result } : { error: result } };
      const completed = await call(
        server.baseUrl,
        'POST',
        `/api/chat/runs/${sent.body.runId}/events`,
        owner.token,
        body,
      );
      expect(completed.status).toBe(200);
      const session = server.handle.messageStore.getSession('sender-live')!;
      const notices = server.handle.chatStore.listMessages(session.roomId!, 'sender@example.com');
      expect(notices).toHaveLength(1);
      const notice = notices[0]!;
      expect(notice.senderSessionId).toBeUndefined();
      expect(notice.content).toContain(`/api/chat/runs/${sent.body.runId}/events`);
      expect(notice.content).toContain(kind === 'complete' ? 'target completed' : 'target failed');
      if (kind === 'complete') {
        expect(notice.content).toContain('…');
        expect(notice.content).not.toContain('full final detail');
      } else {
        expect(notice.content).toContain(result);
      }
      const noticeRun = server.handle.chatStore.getRunByTriggerMessageId(notice.id)!;
      expect(noticeRun.presentation).toMatchObject({
        mode: 'child-direct',
        chatId: 'oc_sender_chat',
        targetAgentRef: 'sender',
      });
      const relay = server.handle.inboxStore.peek('sender', `core-chat:${session.roomId}`, 10);
      expect(relay).toHaveLength(1);
      expect(JSON.parse(relay[0]!.content)).toMatchObject({
        type: 'core-chat-run',
        request: {
          runId: noticeRun.id,
          prompt: notice.content,
          targetBot: 'sender',
          notification: kind === 'error' ? 'error' : 'result',
        },
      });
      const targetRelay = server.handle.inboxStore.peek('target', undefined, 10)[0]!;
      expect(JSON.parse(targetRelay.content).request.notification).toBeUndefined();
      expect(server.handle.chatStore.hasParticipant(session.roomId!, 'user', 'target@example.com')).toBe(false);
      expect(server.handle.chatStore.hasParticipant(session.roomId!, 'agent', 'target')).toBe(false);
      expect(
        (await call(server.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, owner.token, body)).status,
      ).toBe(200);
      expect(server.handle.chatStore.listMessages(session.roomId!, 'sender@example.com')).toHaveLength(1);
      expect(server.handle.inboxStore.peek('sender', `core-chat:${session.roomId}`, 10)).toHaveLength(1);
      expect(
        (
          await call(server.baseUrl, 'POST', `/api/chat/runs/${noticeRun.id}/events`, sender.token, {
            seq: 1,
            kind: 'complete',
            payload: { content: 'ack' },
          })
        ).status,
      ).toBe(200);
      expect(
        (server.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count,
      ).toBe(2);
    },
  );

  it('ignores legacy forged return-session metadata without granting access', async () => {
    const { server, sender, owner, target } = await busFixture();
    const foreign = server.handle.messageStore.ensureSession({
      id: 'victim-return',
      agentId: target.id,
      agentName: 'target',
      status: 'resumable',
    });
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'normal send',
    });
    expect(sent.status).toBe(202);
    server.handle.db
      .prepare('UPDATE chat_messages SET sender_session_id = ? WHERE id = ?')
      .run(foreign.id, sent.body.messageId);
    expect(
      (
        await call(server.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, owner.token, {
          seq: 1,
          kind: 'complete',
          payload: { content: 'private result' },
        })
      ).status,
    ).toBe(200);
    expect(server.handle.messageStore.getSession(foreign.id)!.roomId).toBeUndefined();
    expect((server.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(
      1,
    );
  });

  it('requires the sending identity to own a return address even with an admin token', async () => {
    const { server, target, senderAgent } = await busFixture();
    server.handle.messageStore.ensureSession({
      id: 'member-return',
      agentId: senderAgent.id,
      agentName: 'sender',
      status: 'resumable',
    });
    const sent = await call(server.baseUrl, 'POST', '/api/messages', server.adminToken, {
      agentId: target.id,
      message: 'do not impersonate sender',
      senderSessionId: 'member-return',
    });
    expect(sent.status).toBe(403);
    expect(sent.body.error).toBe('sender_session_ownership_required');
  });

  it('returns empty history for owned unbound sessions and isolates foreign cursors', async () => {
    const { server, sender, owner, target, senderAgent } = await busFixture();
    const empty = server.handle.messageStore.ensureSession({
      id: 'empty',
      agentId: senderAgent.id,
      agentName: 'sender',
    });
    const history = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${empty.id}&limit=999`,
      sender.token,
    );
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({
      messages: [],
      sessionTitle: null,
      hasMore: false,
      oldestMessageId: null,
      limit: 200,
    });
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'first room',
    });
    const other = await call(server.baseUrl, 'POST', '/api/messages', owner.token, {
      agentId: senderAgent.id,
      message: 'another room',
    });
    expect(other.status).toBe(202);
    const page = await call(
      server.baseUrl,
      'GET',
      `/api/messages/history?sessionId=${sent.body.sessionId}&before=${other.body.messageId}`,
      sender.token,
    );
    expect(page.status).toBe(200);
    expect(page.body.messages).toEqual([]);
  });

  it('keeps sticky target bindings implicit unless child-direct is requested', async () => {
    const { server, sender, target } = await busFixture();
    const first = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'seed',
    });
    server.handle.messageStore.ensureSession({
      id: first.body.sessionId,
      agentId: target.id,
      agentName: 'target',
      transportPlatform: 'feishu',
      transportChatId: 'oc_old_chat',
    });
    for (const mode of [undefined, 'implicit']) {
      const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
        agentId: target.id,
        message: 'quiet',
        presentationMode: mode,
      });
      expect(sent.status).toBe(202);
      expect(server.handle.chatStore.getRun(sent.body.runId)!.presentation).toBeNull();
    }
  });

  it('returns across distinct sessions of the same agent but not into the source room', async () => {
    const { server, sender, senderAgent } = await busFixture();
    server.handle.messageStore.ensureSession({
      id: 'return-session',
      agentId: senderAgent.id,
      agentName: 'sender',
      status: 'resumable',
    });
    server.handle.messageStore.ensureSession({
      id: 'work-session',
      agentId: senderAgent.id,
      agentName: 'sender',
      status: 'resumable',
    });
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: senderAgent.id,
      sessionId: 'work-session',
      senderSessionId: 'return-session',
      message: 'same agent work',
    });
    expect(sent.status).toBe(202);
    expect(
      (
        await call(server.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, sender.token, {
          seq: 1,
          kind: 'complete',
          payload: { content: 'done' },
        })
      ).status,
    ).toBe(200);
    expect(server.handle.messageStore.getSession('return-session')!.roomId).toBeDefined();
    const same = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: senderAgent.id,
      sessionId: 'work-session',
      senderSessionId: 'work-session',
      message: 'same room',
    });
    expect(same.status).toBe(202);
    expect(
      (
        await call(server.baseUrl, 'POST', `/api/chat/runs/${same.body.runId}/events`, sender.token, {
          seq: 1,
          kind: 'complete',
          payload: { content: 'done' },
        })
      ).status,
    ).toBe(200);
    expect((server.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(
      3,
    );
  });

  it('does not pingback origin-proxy runs', async () => {
    const { server, sender, owner, target, senderAgent } = await busFixture();
    server.handle.messageStore.ensureSession({
      id: 'origin-session',
      agentId: senderAgent.id,
      agentName: 'sender',
      status: 'resumable',
    });
    const sent = await call(server.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: target.id,
      message: 'proxy',
      senderSessionId: 'origin-session',
      presentationMode: 'origin-proxy',
      originBotName: 'sender',
      originChatId: 'oc_origin_chat',
    });
    expect(sent.status).toBe(202);
    expect(
      (
        await call(server.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, owner.token, {
          seq: 1,
          kind: 'complete',
          payload: { content: 'done' },
        })
      ).status,
    ).toBe(200);
    expect(server.handle.messageStore.getSession('origin-session')!.roomId).toBeUndefined();
  });

  it('creates a logical session on first send and reuses it', async () => {
    kit = await startTestServer('minimal-message');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const first = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, { agentId: rec.id, message: 'hello' });
    expect(first.status).toBe(202);
    expect(first.body.sessionId).toEqual(expect.any(String));
    const listed = await call(kit.baseUrl, 'GET', `/api/agents/${encodeURIComponent(rec.id)}/sessions`, sender.token);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    const logicalSession = listed.body.sessions[0] as { id: string; roomId: string };
    const providerMirror = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: rec.id,
      sessionId: 'bridge-local-session-id',
      roomId: logicalSession.roomId,
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(providerMirror.status).toBe(201);
    expect(providerMirror.body.session).toMatchObject({
      id: first.body.sessionId,
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(kit.handle.messageStore.listSessions(rec.id).total).toBe(1);
    const second = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      sessionId: first.body.sessionId,
      message: 'again',
      presentationMode: 'child-direct',
    });
    expect(second.status).toBe(202);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(kit.handle.chatStore.getRun(String(second.body.runId))?.presentation).toEqual({
      mode: 'child-direct',
      chatId: 'oc_target_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
    });

    const implicit = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      sessionId: first.body.sessionId,
      message: 'background only',
      presentationMode: 'implicit',
    });
    expect(implicit.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(implicit.body.runId))?.presentation).toBeNull();
  });

  it('uses the ChatStore message as the canonical record', async () => {
    kit = await startTestServer('minimal-message-canonical-record');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const senderAgent = kit.handle.agentStore.register({
      botName: 'sender',
      url: 'inbox:',
      ownerCredentialId: sender.credentialId,
      ownerName: 'sender@example.com',
    });
    kit.handle.messageStore.ensureSession({
      id: 'sender-session',
      agentId: senderAgent.id,
      agentName: 'sender',
      status: 'resumable',
    });

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'canonical message',
      replyTo: 'prior-message',
      senderSessionId: 'sender-session',
      idempotencyKey: 'canonical-key',
    });
    expect(sent.status).toBe(202);
    const message = kit.handle.chatStore.getMessage(String(sent.body.messageId));
    expect(message).toMatchObject({
      id: sent.body.messageId,
      content: 'canonical message',
      replyTo: 'prior-message',
      senderSessionId: 'sender-session',
    });
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM bus_messages').get() as { count: number }).count).toBe(
      0,
    );

    const replay = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      sessionId: sent.body.sessionId,
      message: 'canonical message',
      idempotencyKey: 'canonical-key',
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      idempotentReplay: true,
      messageId: sent.body.messageId,
      runId: sent.body.runId,
      sessionId: sent.body.sessionId,
    });
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(1);

    const ack = await call(
      kit.baseUrl,
      'POST',
      `/api/messages/${encodeURIComponent(String(sent.body.messageId))}/ack`,
      owner.token,
    );
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ canonical: true, deliveryStatus: 'queued' });
    expect(ack.body.message).toMatchObject({ status: 'pending', text: 'canonical message' });
  });

  it('reuses a provisioning session instead of creating a second context', async () => {
    kit = await startTestServer('minimal-message-provisioning');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const first = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'first',
    });
    const second = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      message: 'second',
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(kit.handle.messageStore.listSessions(rec.id).total).toBe(1);
  });

  it('serializes concurrent idempotent sends into one run', async () => {
    kit = await startTestServer('minimal-message-concurrent-idempotency');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const results = await Promise.all(
      [1, 2].map(() =>
        call(kit!.baseUrl, 'POST', '/api/messages', sender.token, {
          agentId: rec.id,
          message: 'retry safely',
          idempotencyKey: 'concurrent-key',
        }),
      ),
    );
    expect(results.every((result) => result.status === 202)).toBe(true);
    expect(results[0]!.body.runId).toBe(results[1]!.body.runId);
    expect((kit.handle.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get() as { count: number }).count).toBe(1);
  });

  it('forwards target-session presentation to the bridge relay payload', async () => {
    kit = await startTestServer('minimal-message-relay-presentation');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const rec = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const room = kit.handle.chatStore.createConversation({
      kind: 'dm',
      createdBy: 'sender@example.com',
      participants: [{ kind: 'agent', ref: 'target' }],
    });
    const seed = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: rec.id,
      sessionId: 'target-feishu-session',
      roomId: room.id,
      provider: 'codex',
      providerSessionId: 'codex-thread-id',
      status: 'resumable',
      transportChatId: 'oc_target_chat',
      transportPlatform: 'feishu',
    });
    expect(seed.status).toBe(201);

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: rec.id,
      sessionId: 'target-feishu-session',
      message: 'hello target chat',
      presentationMode: 'child-direct',
    });
    expect(sent.status).toBe(202);
    const relay = kit.handle.inboxStore.peek('target', undefined, 1)[0];
    expect(relay).toBeDefined();
    const payload = JSON.parse(relay!.content) as { request: { presentation?: unknown } };
    expect(payload.request.presentation).toEqual({
      mode: 'child-direct',
      chatId: 'oc_target_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
    });
  });

  it('stores origin-proxy presentation and relays run events back to the sender bridge', async () => {
    kit = await startTestServer('minimal-message-origin-proxy');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });

    const sent = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: 'target',
      message: 'run remotely',
      presentationMode: 'origin-proxy',
      originChatId: 'oc_origin_chat',
      originBotName: 'sender',
    });
    expect(sent.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(sent.body.runId))?.presentation).toEqual({
      mode: 'origin-proxy',
      chatId: 'oc_origin_chat',
      targetAgentRef: 'target',
      requestedBy: 'sender',
      originBotName: 'sender',
      wakeLead: true,
    });

    const event = await call(kit.baseUrl, 'POST', `/api/chat/runs/${sent.body.runId}/events`, owner.token, {
      seq: 1,
      kind: 'complete',
      payload: { content: 'remote result', state: { responseText: 'remote result', toolCalls: [] } },
    });
    expect(event.status).toBe(200);
    const projection = kit.handle.inboxStore.peek('sender', `core-chat-proxy:${sent.body.runId}`, 1)[0];
    expect(projection).toBeDefined();
    expect(JSON.parse(projection!.content)).toMatchObject({
      type: 'core-chat-proxy',
      targetAgentRef: 'target',
      originChatId: 'oc_origin_chat',
      wakeLead: true,
      event: { seq: 1, kind: 'complete' },
    });
  });

  it('allows an admin to project through a registered origin bot', async () => {
    kit = await startTestServer('minimal-message-admin-origin-proxy');
    const target = await issue(kit, 'target-owner', 'target@example.com');
    kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: target.credentialId,
      ownerName: 'target@example.com',
    });
    const sent = await call(kit.baseUrl, 'POST', '/api/messages', kit.adminToken, {
      agentId: 'target',
      message: 'project from admin',
      presentationMode: 'origin-proxy',
      originChatId: 'oc_admin_origin_chat',
      originBotName: 'target',
    });
    expect(sent.status).toBe(202);
    expect(kit.handle.chatStore.getRun(String(sent.body.runId))?.presentation).toMatchObject({
      mode: 'origin-proxy',
      chatId: 'oc_admin_origin_chat',
      originBotName: 'target',
    });
  });

  it('searches by username with bounded pagination', async () => {
    kit = await startTestServer('minimal-search');
    const token = await issue(kit, 'searcher', 'alice@example.com');
    kit.handle.agentStore.register({
      botName: 'robot-a',
      url: 'inbox:',
      description: 'vision',
      ownerCredentialId: 'owner-a',
      ownerName: 'bob@example.com',
    });
    kit.handle.agentStore.register({
      botName: 'robot-b',
      url: 'inbox:',
      description: 'planning',
      ownerCredentialId: 'owner-b',
      ownerName: 'alice@example.com',
    });
    const result = await call(kit.baseUrl, 'GET', '/api/agents/search?user=alice@example.com&limit=1', token.token);
    expect(result.status).toBe(200);
    expect(result.body.agents).toHaveLength(1);
    expect(result.body.hasMore).toBe(false);
  });

  it('rejects invalid session status instead of persisting arbitrary state', async () => {
    kit = await startTestServer('minimal-session-status-validation');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const result = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: 'target',
      status: 'mysterious',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_session_status');
  });

  it('does not enqueue onto an explicitly offline session', async () => {
    kit = await startTestServer('minimal-session-offline');
    const sender = await issue(kit, 'sender', 'sender@example.com');
    const owner = await issue(kit, 'target-owner', 'target@example.com');
    const agent = kit.handle.agentStore.register({
      botName: 'target',
      url: 'inbox:',
      ownerCredentialId: owner.credentialId,
      ownerName: 'target@example.com',
    });
    const room = kit.handle.chatStore.createConversation({
      kind: 'dm',
      createdBy: 'sender@example.com',
      participants: [{ kind: 'agent', ref: 'target' }],
    });
    const session = await call(kit.baseUrl, 'POST', '/api/messages/sessions', owner.token, {
      agentId: agent.id,
      status: 'offline',
      roomId: room.id,
    });
    expect(session.status).toBe(201);
    const result = await call(kit.baseUrl, 'POST', '/api/messages', sender.token, {
      agentId: agent.id,
      sessionId: session.body.session.id,
      message: 'must wait for resume',
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('session_offline');
  });
});
