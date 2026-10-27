import { describe, expect, it, vi } from 'vitest';
import { SlashPickerController } from '../src/bridge/slash-picker-controller.js';
import type { IncomingMessage } from '../src/types.js';
import type { SessionSummary } from '../src/engines/claude/session-lister.js';

function message(text: string): IncomingMessage {
  return {
    messageId: 'message-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    userId: 'user-1',
    text,
  };
}

function buildController() {
  let busy = false;
  const notices: Array<{ title: string; content: string; color?: string }> = [];
  const finalized: Array<{ messageId: string; state: Record<string, unknown> }> = [];
  const sentCards: any[] = [];
  const listSessionsForChat = vi.fn(async (): Promise<SessionSummary[]> => [{
    sessionId: 'abc12345-1111-1111-1111-111111111111',
    preview: 'Earlier task',
    lastActive: Date.now(),
    sizeBytes: 1,
    isCurrent: false,
  }]);
  const applyResume = vi.fn(async () => {});

  const controller = new SlashPickerController({
    config: {
      name: 'test',
      engine: 'claude',
      claude: {
        defaultWorkingDirectory: '/tmp',
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        model: undefined,
        apiKey: undefined,
        outputsBaseDir: '/tmp/outputs',
        downloadsDir: '/tmp/downloads',
        backend: 'sdk',
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any,
    sender: {
      sendQuestionCard: vi.fn(async (_chatId: string, state: unknown) => {
        sentCards.push(state);
        return 'picker-card';
      }),
      sendCard: vi.fn(async () => 'picker-card'),
      sendTextNotice: vi.fn(async (_chatId: string, title: string, content: string, color?: string) => {
        notices.push({ title, content, color });
      }),
    } as any,
    sessionManager: {
      getSession: vi.fn(() => ({
        engine: 'claude',
        workingDirectory: '/tmp',
      })),
    } as any,
    outputsManager: {} as any,
    listSessionsForChat,
    applyResume,
    finalizeQuestionCard: vi.fn(async (messageId, state) => {
      finalized.push({ messageId, state: state as unknown as Record<string, unknown> });
    }),
    handleMessage: vi.fn(async () => {}),
    isBusy: () => busy,
    prepareSessionForExecution: vi.fn(),
    runOneTurn: vi.fn(),
  });

  return {
    controller,
    listSessionsForChat,
    applyResume,
    notices,
    finalized,
    sentCards,
    setBusy(value: boolean) {
      busy = value;
    },
  };
}

describe('SlashPickerController /resume busy guard', () => {
  it('refuses to open the picker while a task is active', async () => {
    const kit = buildController();
    kit.setBusy(true);

    await expect(kit.controller.tryOpen(message('/resume'))).resolves.toBe(true);

    expect(kit.listSessionsForChat).not.toHaveBeenCalled();
    expect(kit.applyResume).not.toHaveBeenCalled();
    expect(kit.notices).toEqual([{
      title: '⏳ Task In Progress',
      content: 'A task is running. Use `/stop` first, then `/resume`.',
      color: 'orange',
    }]);
  });

  it('cancels and clears a pending picker if a task starts before the reply', async () => {
    const kit = buildController();
    await expect(kit.controller.tryOpen(message('/resume'))).resolves.toBe(true);

    kit.setBusy(true);
    await expect(kit.controller.tryHandleReply(message('1'))).resolves.toBe(true);

    expect(kit.applyResume).not.toHaveBeenCalled();
    expect(kit.finalized).toHaveLength(1);
    expect(kit.finalized[0]).toMatchObject({
      messageId: 'picker-card',
      state: {
        status: 'error',
        userPrompt: '/resume',
        errorMessage: 'Task in progress',
      },
    });

    kit.setBusy(false);
    await expect(kit.controller.tryHandleReply(message('1'))).resolves.toBe(false);
  });
});

describe('SlashPickerController /resume layout', () => {
  it('shows time and engine title, keeps ids/current marker/preview in details, and resumes by id', async () => {
    const kit = buildController();
    kit.listSessionsForChat.mockResolvedValue([
      { sessionId: 'named-session', name: 'Fix login redirect', preview: 'Original prompt', lastActive: Date.now(), sizeBytes: 1, isCurrent: true },
      { sessionId: 'preview-session', preview: 'Second\n  prompt', lastActive: Date.now() - 60_000, sizeBytes: 1, isCurrent: false },
      { sessionId: 'deadbeef-session', preview: '(no preview)', lastActive: Date.now() - 3_600_000, sizeBytes: 1, isCurrent: false },
    ]);
    expect(await kit.controller.tryOpen(message('/resume'))).toBe(true);
    const options = kit.sentCards[0].pendingQuestion.questions[0].options;
    expect(options).toEqual([
      { label: 'now · Fix login redirect', description: 'named-se · current · Original prompt' },
      { label: '1m ago · Second prompt', description: 'preview-' },
      { label: '1h ago · deadbeef', description: 'deadbeef' },
    ]);
    expect(await kit.controller.tryHandleReply(message('1'))).toBe(true);
    expect(kit.applyResume).toHaveBeenCalledWith('chat-1', 'named-session');
  });

  it('truncates long titles and collapses whitespace in labels', async () => {
    const kit = buildController();
    kit.listSessionsForChat.mockResolvedValue([{
      sessionId: 'long-session', name: `Long\n  ${'name'.repeat(20)}`, preview: '(no preview)', lastActive: Date.now(), sizeBytes: 1, isCurrent: false,
    }]);
    await kit.controller.tryOpen(message('/resume'));
    const option = kit.sentCards[0].pendingQuestion.questions[0].options[0];
    expect(option.label).toBe(`now · ${`Long ${'name'.repeat(20)}`.slice(0, 48)}…`);
    expect(option.description).toBe('long-ses');
  });
});
