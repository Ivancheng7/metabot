import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPostCompactHook, createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';
import type { ExecCommandHook } from '../src/engines/claude/pty/hook-bridge.js';

// Every character class a shell could interpret: spaces, quotes, parameter
// expansion, command substitution, backticks, cmd `%VAR%`, history `!`, and a
// Claude Code `${...}` placeholder.
const HOSTILE = "it's $HOOK_SUFFIX $(touch pwned) `touch pwned` %HOOK_SUFFIX% !1 ${CLAUDE_PROJECT_DIR}";
const PAYLOAD = JSON.stringify({ hook_event_name: 'PostCompact', trigger: 'manual' });

const originalTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
const cleanup: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries(originalTmp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostileDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'metabot-hook-'));
  cleanup.push(root);
  const dir = join(root, HOSTILE);
  mkdirSync(dir);
  return dir;
}

/** Spawn an exec-form hook the way Claude Code does: no shell, args verbatim. */
function runExecHook(hook: ExecCommandHook, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, hook.args, {
      cwd, shell: false, stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, HOOK_SUFFIX: 'expanded' },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(PAYLOAD);
  });
}

describe('PostCompact hook', () => {
  it('uses exec form with opaque arguments instead of a shell command string', () => {
    const hook = buildPostCompactHook(`C:\\Users\\a$b\\${HOSTILE}\\compact.flag`, 'C:\\Program Files\\nodejs\\node.exe');
    expect(hook.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(hook).not.toHaveProperty('shell');
    expect(hook.args).toHaveLength(3);
    expect(hook.args[2]).toMatch(/^[0-9a-f]+$/);
    // Nothing a shell or Claude Code placeholder substitution could rewrite.
    expect(hook.args.join(' ')).not.toMatch(/[$`%"!]/);
  });

  it('writes the literal sentinel when both the interpreter and sentinel paths are hostile', async () => {
    const dir = hostileDir();
    const nodeLink = join(dir, 'node');
    symlinkSync(process.execPath, nodeLink);
    const flag = join(dir, 'compact.flag');

    const result = await runExecHook(buildPostCompactHook(flag, nodeLink), dir);
    expect(result).toEqual({ code: 0, stderr: '' });
    expect(readFileSync(flag, 'utf8')).toBe(PAYLOAD);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('fires onCompactComplete for a bridge whose temp dir is hostile', async () => {
    const dir = hostileDir();
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = dir;
    const bridge = createHookBridge();
    try {
      const settingsPath = await bridge.writeSettings();
      expect(settingsPath.startsWith(dir)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PostCompact: Array<{ matcher: string; hooks: ExecCommandHook[] }> };
      };
      const [entry] = settings.hooks.PostCompact;
      expect(entry.matcher).toBe('manual');

      const completed = new Promise<void>(resolve => bridge.onCompactComplete?.(resolve));
      const result = await runExecHook(entry.hooks[0], dir);
      expect(result).toEqual({ code: 0, stderr: '' });
      expect(readFileSync(join(settingsPath, '..', 'compact.flag'), 'utf8')).toBe(PAYLOAD);
      await completed;
    } finally {
      await bridge.dispose();
    }
  });
});
