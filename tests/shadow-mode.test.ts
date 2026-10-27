import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ShadowMode, type ShadowModeDeps, type ShadowTurn } from '../src/bridge/shadow-mode.js';

function message(overrides: Partial<{ messageId: string; chatId: string; userId: string; text: string }> = {}) {
  return {
    messageId: 'om_user_1',
    chatId: 'oc_shadow',
    chatType: 'group',
    userId: 'ou_owner',
    text: 'initial task',
    ...overrides,
  };
}

describe('ShadowMode', () => {
  it('reports idle status without activating or taking ownership', async () => {
    const generate = vi.fn(async () => 'continue');
    const deliver = vi.fn(async () => 'om_shadow');
    const notice = vi.fn(async () => {});
    const shadow = new ShadowMode({ generate, deliver, notice, profilePath: '/does/not/exist', targetMention: () => '' });
    await shadow.command(message(), 'STATUS');
    expect(generate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('oc_shadow', 'Shadow Mode', 'Shadow 当前未运行。', 'blue');
    expect(shadow.stop('oc_shadow')).toBe(false);
  });

  it('does not let another user update, stop, or reactivate an active run', async () => {
    const generate = vi.fn(async () => 'continue');
    const notice = vi.fn(async () => {});
    const shadow = new ShadowMode({
      generate, deliver: vi.fn(async () => 'om_shadow'), notice, profilePath: '/does/not/exist', targetMention: () => '',
    });
    await shadow.command(message(), 'Owner Goal');
    for (const action of ['Other Goal', 'stop', '']) {
      await shadow.command(message({ userId: 'ou_other' }), action);
      expect(notice).toHaveBeenLastCalledWith('oc_shadow', 'Shadow Mode', expect.stringContaining('只有'), 'orange');
    }
    await shadow.command(message({ userId: 'ou_other' }), 'status');
    expect(notice).toHaveBeenLastCalledWith('oc_shadow', 'Shadow Mode', expect.stringContaining('Owner Goal'), 'blue');
    await shadow.observeFinal('oc_shadow', 'continue', 'result');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith('oc_shadow', expect.stringContaining('<goal>\nOwner Goal\n</goal>'));
    await shadow.command(message(), 'stop');
    await shadow.observeFinal('oc_shadow', 'continue', 'result');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each(['stop', 'stopAll', 'destroy'])('cancels in-flight generation through the lifecycle %s hook', async (action) => {
    let resolveGeneration: (value: string) => void = () => {};
    const generate = vi.fn(() => new Promise<string>((resolve) => { resolveGeneration = resolve; }));
    const deliver = vi.fn(async () => 'om_shadow');
    const shadow = new ShadowMode({ generate, deliver, notice: vi.fn(async () => {}), profilePath: '/does/not/exist', targetMention: () => '' });
    const command = shadow.command(message(), 'goal');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    if (action === 'destroy') shadow.destroy();
    else if (action === 'stopAll') shadow.stopAll();
    else expect(shadow.stop('oc_shadow')).toBe(true);
    resolveGeneration('late answer');
    await command;
    expect(deliver).not.toHaveBeenCalled();
    if (action === 'destroy') {
      await shadow.command(message(), 'new goal');
      await shadow.observeFinal('oc_shadow', 'late input', 'late final');
      expect(generate).toHaveBeenCalledTimes(1);
    }
  });

  it('stops every chat before pending generations resolve and tolerates repeated stopAll calls', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const generate = vi.fn(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    const deliver = vi.fn(async () => 'om_shadow');
    const notice = vi.fn(async () => {});
    const shadow = new ShadowMode({ generate, deliver, notice, profilePath: '/does/not/exist', targetMention: () => '' });
    const commands = ['oc_first', 'oc_second'].map((chatId) => shadow.command(message({ chatId }), 'goal'));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));

    shadow.stopAll();
    shadow.stopAll();
    for (const resolve of resolvers) resolve('late answer');
    await Promise.all(commands);

    expect(deliver).not.toHaveBeenCalled();
    for (const chatId of ['oc_first', 'oc_second']) {
      expect(shadow.observeInbound(message({ chatId }))).toBe(false);
      await shadow.observeFinal(chatId, 'late input', 'late final');
      await shadow.command(message({ chatId }), 'status');
      expect(notice).toHaveBeenLastCalledWith(chatId, 'Shadow Mode', 'Shadow 当前未运行。', 'blue');
    }
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('uses distinct bounded idempotency keys across activations', async () => {
    const deliver = vi.fn<ShadowModeDeps['deliver']>(async () => 'om_shadow');
    const shadow = new ShadowMode({
      generate: vi.fn(async () => 'continue'), deliver, notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist', targetMention: () => '',
    });
    await shadow.command(message(), 'goal');
    await shadow.command(message(), 'STOP');
    await shadow.command(message(), 'goal');
    const keys = deliver.mock.calls.map((call) => call[2]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => /^shadow-[a-f0-9]{40}$/.test(key))).toBe(true);
  });

  it.each([
    ['', '<shadow-stop>literal text</shadow-stop>'],
    ['goal', '<shadow-stop-other>not a control signal</shadow-stop-other>'],
    ['goal', '<shadow-stop>unfinished'],
  ])('does not stop on goal-less or malformed completion signals', async (goal, generated) => {
    const deliver = vi.fn(async () => 'om_shadow');
    const shadow = new ShadowMode({
      generate: vi.fn(async () => generated), deliver, notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist', targetMention: () => '',
    });
    await shadow.command(message(), goal);
    expect(deliver).toHaveBeenCalledWith('oc_shadow', generated, expect.any(String));
  });

  it('does not deliver a generation that finishes after explicit stop', async () => {
    let resolveGeneration: (value: string) => void = () => {};
    const generate = vi.fn(() => new Promise<string>((resolve) => { resolveGeneration = resolve; }));
    const deliver = vi.fn(async () => 'om_shadow');
    const shadow = new ShadowMode({
      generate, deliver, notice: vi.fn(async () => {}), profilePath: '/does/not/exist', targetMention: () => '',
    });
    const command = shadow.command(message(), 'goal');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await shadow.command(message(), 'stop');
    resolveGeneration('late answer');
    await command;
    expect(deliver).not.toHaveBeenCalled();
  });

  it('uses only completed Q/A and delivers the next user message with a durable receipt', async () => {
    const generate = vi.fn(async (_chatId: string, prompt: string) => {
      expect(prompt).toContain('User: initial task');
      expect(prompt).toContain('Agent: final response');
      expect(prompt).not.toContain('tool_call');
      return '继续完成并复验。';
    });
    const deliver = vi.fn(async () => 'om_shadow_1');
    const shadow = new ShadowMode({
      generate,
      deliver,
      notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist',
      targetMention: () => '<at user_id="ou_bot">target</at> ',
    });

    await shadow.observeFinal('oc_shadow', 'initial task', 'final response');
    await shadow.command(message(), '');

    expect(generate).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      'oc_shadow',
      '<at user_id="ou_bot">target</at> 继续完成并复验。',
      expect.stringMatching(/^shadow-[a-f0-9]{40}$/),
    );
    expect(shadow.observeInbound(message({ messageId: 'om_shadow_1', text: '继续完成并复验。' }))).toBe(false);
  });

  it('starts immediately without prior Q/A and keeps running when the owner injects a message', async () => {
    const notice = vi.fn(async () => {});
    const generate = vi.fn(async () => 'continue');
    const deliver = vi.fn(async () => 'om_shadow_1');
    const shadow = new ShadowMode({
      generate,
      deliver,
      notice,
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });
    await shadow.command(message(), '');
    expect(generate).toHaveBeenCalledWith('oc_shadow', expect.stringContaining('<activation>'));
    expect(shadow.observeInbound(message({ messageId: 'om_shadow_1', text: 'continue' }))).toBe(false);
    expect(shadow.observeInbound(message({ messageId: 'om_manual', text: '补充：优先跑测试' }))).toBe(true);
    expect(notice).toHaveBeenCalledWith(
      'oc_shadow',
      'Shadow Mode',
      '已收到你的插入信息；Shadow 会继续自动推进，`/auto stop` 可停止。',
      'blue',
    );
    await shadow.observeFinal('oc_shadow', '补充：优先跑测试', '已开始跑测试');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith('oc_shadow', expect.stringContaining('User: 补充：优先跑测试'));
    expect(deliver).toHaveBeenCalledTimes(2);

    await shadow.command(message(), 'stop');
    expect(notice).toHaveBeenCalledWith(
      'oc_shadow',
      'Shadow Mode',
      'Shadow 已停止；不会再代你发送下一轮消息。',
      'orange',
    );
  });

  it('does not stop when the Shadow inbound event arrives before its delivery receipt', async () => {
    let resolveDelivery: ((messageId: string) => void) | undefined;
    const delivery = new Promise<string>((resolve) => {
      resolveDelivery = resolve;
    });
    const notice = vi.fn(async () => {});
    const deliver = vi.fn(async () => delivery);
    const generate = vi.fn(async () => 'continue');
    const shadow = new ShadowMode({
      generate,
      deliver,
      notice,
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    const command = shadow.command(message(), '');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(shadow.observeInbound(message({ messageId: 'om_shadow_1', text: 'continue' }))).toBe(false);
    resolveDelivery?.('om_shadow_1');
    await command;

    expect(shadow.observeInbound(message({ messageId: 'om_manual', text: '插入一条' }))).toBe(true);
    expect(notice).toHaveBeenCalledWith(
      'oc_shadow',
      'Shadow Mode',
      '已收到你的插入信息；Shadow 会继续自动推进，`/auto stop` 可停止。',
      'blue',
    );
    await shadow.observeFinal('oc_shadow', '插入一条', '收到');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('keeps running for a manual owner message sent while the delivery receipt is pending', async () => {
    let resolveDelivery: ((messageId: string) => void) | undefined;
    const delivery = new Promise<string>((resolve) => {
      resolveDelivery = resolve;
    });
    const notice = vi.fn(async () => {});
    const deliver = vi.fn(async () => delivery);
    const generate = vi.fn(async () => 'continue');
    const shadow = new ShadowMode({
      generate,
      deliver,
      notice,
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    const command = shadow.command(message(), '');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(shadow.observeInbound(message({ messageId: 'om_manual', text: '插入一条' }))).toBe(false);
    resolveDelivery?.('om_shadow_1');
    await command;
    expect(notice).not.toHaveBeenCalledWith('oc_shadow', 'Shadow Mode 已停止', expect.any(String), 'blue');
    await shadow.observeFinal('oc_shadow', '插入一条', '收到');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(shadow.observeInbound(message({ messageId: 'om_manual_2', text: '再插入一条' }))).toBe(true);
  });

  it('steers generation with the goal from `/auto <goal>` and supports updating it while running', async () => {
    const notice = vi.fn(async () => {});
    const prompts: string[] = [];
    const generate = vi.fn(async (_chatId: string, prompt: string) => {
      prompts.push(prompt);
      return '先复现登录失败。';
    });
    const shadow = new ShadowMode({
      generate,
      deliver: vi.fn(async () => 'om_shadow_1'),
      notice,
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    await shadow.command(message(), '修复登录接口并跑通测试');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('<goal>\n修复登录接口并跑通测试\n</goal>');
    expect(notice).toHaveBeenCalledWith(
      'oc_shadow',
      'Shadow Mode 已开启',
      expect.stringContaining('目标：修复登录接口并跑通测试'),
      'green',
    );
    await shadow.command(message(), '补充：顺带更新文档');
    expect(notice).toHaveBeenCalledWith('oc_shadow', 'Shadow Mode', '目标已更新：补充：顺带更新文档', 'blue');
    expect(generate).toHaveBeenCalledTimes(1);

    await shadow.observeFinal('oc_shadow', '先复现登录失败。', '已复现');
    expect(generate).toHaveBeenLastCalledWith(
      'oc_shadow',
      expect.stringContaining('<goal>\n补充：顺带更新文档\n</goal>'),
    );
  });

  it('stops automatically when the Shadow model judges the goal complete', async () => {
    const notice = vi.fn(async () => {});
    const deliver = vi.fn(async () => 'om_shadow_1');
    const generate = vi
      .fn()
      .mockImplementationOnce(async () => '先修复。')
      .mockImplementationOnce(async () => '<shadow-stop>登录接口已修复，测试全部通过</shadow-stop>');
    const shadow = new ShadowMode({
      generate,
      deliver,
      notice,
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    await shadow.command(message(), '修复登录接口并跑通测试');
    expect(deliver).toHaveBeenCalledTimes(1);
    await shadow.observeFinal('oc_shadow', '先修复。', '已修复并通过测试');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      'oc_shadow',
      'Shadow Mode 已自动停止',
      '目标已达成：登录接口已修复，测试全部通过',
      'green',
    );
    await shadow.observeFinal('oc_shadow', '先修复。', '重复完成');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('replaces an accidental MetaBot control command with a normal continuation message', async () => {
    const deliver = vi.fn(async () => 'om_shadow_1');
    const shadow = new ShadowMode({
      generate: vi.fn(async () => '/auto'),
      deliver,
      notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    await shadow.command(message(), '');

    expect(deliver).toHaveBeenCalledWith(
      'oc_shadow',
      '请继续按当前目标推进，并在完成后给出可验证的结果。',
      expect.stringMatching(/^shadow-[a-f0-9]{40}$/),
    );
  });

  it('retains more than 100 Q/A pairs without a fixed turn cap and persists the complete budgeted trajectory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-shadow-'));
    const statePath = join(dir, 'shadow-mode.json');
    const prompts: string[] = [];
    let delivery = 0;
    const shadow = new ShadowMode({
      generate: vi.fn(async (_chatId: string, prompt: string) => {
        prompts.push(prompt);
        return '继续。';
      }),
      deliver: vi.fn(async () => `om_shadow_${++delivery}`),
      notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist',
      statePath,
      targetMention: () => '',
    });

    try {
      await shadow.command(message(), '');
      for (let turnIndex = 1; turnIndex <= 101; turnIndex++) {
        await shadow.observeFinal('oc_shadow', `question-${turnIndex}`, `answer-${turnIndex}`);
      }

      const latest = prompts.at(-1) || '';
      expect(latest).toContain('User: question-1');
      expect(latest).toContain('Agent: answer-101');
      expect(delivery).toBe(102);

      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { recent: Record<string, ShadowTurn[]> };
      expect(persisted.recent.oc_shadow).toHaveLength(101);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims only the oldest Q/A pairs when the 128 KiB serialized trajectory budget is exceeded', async () => {
    const prompts: string[] = [];
    const shadow = new ShadowMode({
      generate: vi.fn(async (_chatId: string, prompt: string) => {
        prompts.push(prompt);
        return '继续。';
      }),
      deliver: vi.fn(async () => 'om_shadow'),
      notice: vi.fn(async () => {}),
      profilePath: '/does/not/exist',
      targetMention: () => '',
    });

    await shadow.command(message(), '');
    await shadow.observeFinal('oc_shadow', `old-${'x'.repeat(70 * 1024)}`, 'old-answer');
    await shadow.observeFinal('oc_shadow', `new-${'y'.repeat(70 * 1024)}`, 'new-answer');

    const latest = prompts.at(-1) || '';
    expect(latest).not.toContain('old-answer');
    expect(latest).toContain('new-answer');
  });
});
