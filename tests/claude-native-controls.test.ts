import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '../src/utils/async-queue.js';
import { createLogger } from '../src/utils/logger.js';
import type { PtyUserMessage, PtyHookBridge, PtyQuery } from '../src/engines/claude/pty/contract.js';

const fake = vi.hoisted(() => ({
  session: {
    sessionId: 'claude-session', jsonlPath: '/unused',
    ready: vi.fn(async () => {}), typePrompt: vi.fn(async () => {}),
    steerPrompt: vi.fn(async (_text: string, _isCurrent?: () => boolean) => true), screen: vi.fn(() => '❯'),
    snapshot: vi.fn(() => '❯'), sendKeys: vi.fn(),
    interrupt: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  },
}));
vi.mock('../src/engines/claude/pty/pty-session.js', () => ({ createPtyClaudeSession: () => fake.session }));
vi.mock('../src/engines/claude/pty/jsonl-scanner.js', () => ({
  createJsonlScanner: () => ({
    stop() {},
    async *[Symbol.asyncIterator]() { yield* []; await new Promise(() => {}); },
  }),
}));
import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';

const queries: PtyQuery[] = [];
afterEach(async () => {
  for (const query of queries.splice(0)) await query.dispose?.();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function start(prompt: string) {
  const input = new AsyncQueue<PtyUserMessage>();
  let stop!: () => void;
  const hooks: PtyHookBridge = {
    writeSettings: async () => '/unused-settings',
    onTurnComplete: cb => { stop = cb; },
    onTeamEvent() {}, dispose: async () => {},
  };
  const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
  queries.push(query);
  input.enqueue({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });
  await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith(prompt));
  return { query, stop: () => stop() };
}
describe('Claude Code native controls', () => {
  it('submits steering to the live composer without opening another turn or interrupting', async () => {
    const ctx = await start('initial task');
    expect(ctx.query.canSteer?.()).toBe(true);
    expect(await ctx.query.steer?.('new direction')).toBe('steered');
    expect(fake.session.steerPrompt).toHaveBeenCalledWith('new direction', expect.any(Function));
    expect(fake.session.typePrompt).toHaveBeenCalledTimes(1);
    expect(fake.session.interrupt).not.toHaveBeenCalled();
    ctx.stop();
    expect(await ctx.query.steer?.('late')).toBe('no-active-turn');
  });

  /** Hold steerPrompt until released; report what ownership looked like before "Enter". */
  function holdSteer() {
    let release!: () => void;
    let owned: boolean | undefined;
    fake.session.steerPrompt.mockImplementationOnce((_text, isCurrent) => new Promise<boolean>(resolve => {
      release = () => { owned = isCurrent?.() ?? true; resolve(owned); };
    }));
    return { release: () => release(), ownedAtEnter: () => owned, held: () => vi.waitFor(() => expect(release).toBeDefined()) };
  }

  it('rejects steering when the turn completes during submission', async () => {
    const ctx = await start('initial task');
    const hold = holdSteer();
    const pending = ctx.query.steer!('late direction');
    await hold.held();
    ctx.stop();
    hold.release();
    expect(await pending).toBe('no-active-turn');
    expect(hold.ownedAtEnter()).toBe(false);
  });

  it('rejects steering when the turn completes even if the session ignored ownership', async () => {
    const ctx = await start('initial task');
    let release!: () => void;
    fake.session.steerPrompt.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    const pending = ctx.query.steer!('late direction');
    await vi.waitFor(() => expect(release).toBeDefined());
    ctx.stop();
    release();
    expect(await pending).toBe('no-active-turn');
  });

  it('rejects steering when the turn is cancelled during submission', async () => {
    const ctx = await start('initial task');
    const hold = holdSteer();
    const pending = ctx.query.steer!('late direction');
    await hold.held();
    const interrupted = ctx.query.interrupt();
    expect(ctx.query.canSteer?.()).toBe(false);
    hold.release();
    await interrupted;
    expect(await pending).toBe('no-active-turn');
    expect(hold.ownedAtEnter()).toBe(false);
    expect(await ctx.query.steer!('after stop')).toBe('no-active-turn');
  });

  it('does not let a stale steer claim the next turn', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    let stop!: () => void;
    const hooks: PtyHookBridge = {
      writeSettings: async () => '/unused-settings',
      onTurnComplete: cb => { stop = cb; },
      onTeamEvent() {}, dispose: async () => {},
    };
    const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
    queries.push(query);
    const send = (content: string) => input.enqueue({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
    send('first');
    await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith('first'));
    const hold = holdSteer();
    const pending = query.steer!('late direction');
    await hold.held();
    stop();
    send('queued follow-up');
    // The follow-up waits for the stale steer to finish withdrawing its text.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.session.typePrompt).not.toHaveBeenCalledWith('queued follow-up');
    hold.release();
    expect(await pending).toBe('no-active-turn');
    await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith('queued follow-up'));
    expect(hold.ownedAtEnter()).toBe(false);
    expect(fake.session.typePrompt).not.toHaveBeenCalledWith(expect.stringContaining('late direction'));
  });

  it('keeps steering blocked while a follow-up prompt is still being typed after a stale steer', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks: PtyHookBridge = {
      writeSettings: async () => '/unused-settings',
      onTurnComplete() {}, onTeamEvent() {}, dispose: async () => {},
    };
    const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
    queries.push(query);
    const send = (content: string) => input.enqueue({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
    send('first');
    await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith('first'));
    const hold = holdSteer();
    const stale = query.steer!('stale direction');
    await hold.held();
    await query.interrupt();
    let finishTyping!: () => void;
    fake.session.typePrompt.mockImplementationOnce(() => new Promise<void>(resolve => { finishTyping = resolve; }));
    send('follow-up');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.session.typePrompt).not.toHaveBeenCalledWith('follow-up');
    hold.release();
    expect(await stale).toBe('no-active-turn');
    await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith('follow-up'));
    // The follow-up is still being typed: no other composer write may start.
    expect(query.canSteer?.()).toBe(false);
    const steerCalls = fake.session.steerPrompt.mock.calls.length;
    expect(await query.steer!('interleaved')).toBe('no-active-turn');
    expect(fake.session.steerPrompt).toHaveBeenCalledTimes(steerCalls);
    finishTyping();
    await vi.waitFor(() => expect(query.canSteer?.()).toBe(true));
  });

  it('keeps steering blocked until every overlapping interrupt has finished', async () => {
    const ctx = await start('initial task');
    let finishFirst!: () => void;
    fake.session.interrupt.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; }));
    let finishSecond!: () => void;
    fake.session.interrupt.mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve; }));
    const first = ctx.query.interrupt();
    const second = ctx.query.interrupt();
    await vi.waitFor(() => expect(fake.session.interrupt).toHaveBeenCalledTimes(2));
    finishFirst();
    await first;
    expect(ctx.query.canSteer?.()).toBe(false);
    expect(await ctx.query.steer!('during second interrupt')).toBe('no-active-turn');
    expect(fake.session.steerPrompt).not.toHaveBeenCalled();
    finishSecond();
    await second;
  });

  it('does not write a steer to the PTY while a prompt is being typed', async () => {
    const input = new AsyncQueue<PtyUserMessage>();
    const hooks: PtyHookBridge = {
      writeSettings: async () => '/unused-settings',
      onTurnComplete() {}, onTeamEvent() {}, dispose: async () => {},
    };
    let finishTyping!: () => void;
    fake.session.typePrompt.mockImplementationOnce(() => new Promise<void>(resolve => { finishTyping = resolve; }));
    const query = ptyQuery({ prompt: input, options: { cwd: '/unused', logger: createLogger('silent'), hookBridge: hooks } });
    queries.push(query);
    input.enqueue({ type: 'user', message: { role: 'user', content: 'slow prompt' }, parent_tool_use_id: null, session_id: '' });
    await vi.waitFor(() => expect(fake.session.typePrompt).toHaveBeenCalledWith('slow prompt'));
    expect(query.canSteer?.()).toBe(false);
    expect(await query.steer!('too early')).toBe('no-active-turn');
    expect(fake.session.steerPrompt).not.toHaveBeenCalled();
    finishTyping();
    await vi.waitFor(() => expect(query.canSteer?.()).toBe(true));
  });
});

