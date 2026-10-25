import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/utils/logger.js';

const fake = vi.hoisted(() => ({ writes: [] as string[], emit: (_data: string) => {} }));
vi.mock('node-pty', () => ({
  spawn: () => ({
    write: (data: string) => { fake.writes.push(data); },
    onData: (cb: (data: string) => void) => { fake.emit = cb; },
    onExit: () => {},
    kill: () => {},
  }),
}));
import { createPtyClaudeSession } from '../src/engines/claude/pty/pty-session.js';

const home = mkdtempSync(join(tmpdir(), 'pty-steer-home-'));
const prevHome = process.env.HOME;
beforeAll(() => { process.env.HOME = home; });
afterAll(() => { process.env.HOME = prevHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { fake.writes.length = 0; });

async function session() {
  const s = createPtyClaudeSession({ cwd: home, settingsPath: '/unused', logger: createLogger('silent') });
  fake.emit('❯ ');
  await vi.waitFor(() => expect(s.screen()).toContain('❯'));
  return s;
}
const pasteIndex = () => fake.writes.findIndex(w => w.startsWith('\x1b[200~'));

describe('Claude PTY steering submission', () => {
  it('submits with Enter while the turn is still owned', async () => {
    const s = await session();
    expect(await s.steerPrompt!('new direction', () => true)).toBe(true);
    expect(fake.writes.slice(pasteIndex() + 1)).toEqual(['\r']);
    await s.dispose();
  });

  it('withholds Enter and clears the composer when the turn ends during submission', async () => {
    const s = await session();
    let owned = true;
    const pending = s.steerPrompt!('line one\nline two', () => owned);
    await vi.waitFor(() => expect(pasteIndex()).toBeGreaterThanOrEqual(0));
    owned = false; // Stop hook / interrupt lands inside the paste→Enter window
    expect(await pending).toBe(false);
    const after = fake.writes.slice(pasteIndex() + 1).join('');
    expect(after).not.toContain('\r');
    expect(after).not.toContain('\x03'); // a second Ctrl-C could exit claude
    expect(after).toContain('\x15');
    await s.dispose();
  });

  it('does not paste at all when ownership is already lost', async () => {
    const s = await session();
    expect(await s.steerPrompt!('late', () => false)).toBe(false);
    expect(pasteIndex()).toBe(-1);
    await s.dispose();
  });

  it('types a queued follow-up only after a withdrawn steer has been cleared', async () => {
    const s = await session();
    await s.ready();
    let owned = true;
    const steer = s.steerPrompt!('stale text', () => owned);
    await vi.waitFor(() => expect(pasteIndex()).toBeGreaterThanOrEqual(0));
    const typed = s.typePrompt('follow-up');
    owned = false;
    await steer;
    await typed;
    const order = fake.writes.join('');
    const cleared = order.lastIndexOf('\x15');
    expect(cleared).toBeGreaterThan(order.indexOf('stale text'));
    expect(order.indexOf('f', cleared)).toBeGreaterThan(cleared);
    expect(order.slice(order.indexOf('stale text'), cleared)).not.toContain('\r');
    await s.dispose();
  }, 20_000);
});
