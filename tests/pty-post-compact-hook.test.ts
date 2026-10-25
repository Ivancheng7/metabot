import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPostCompactHookCommand, createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

const originalTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
const cleanup: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries(originalTmp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run a hook command through the shell, the way Claude Code executes command hooks. */
function runHook(command: string, stdin: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

describe('PostCompact hook command', () => {
  it('quotes paths and avoids `cat` on every platform', () => {
    expect(buildPostCompactHookCommand('/tmp/my dir/compact.flag', 'linux', '/usr/bin/node'))
      .toMatch(/^'\/usr\/bin\/node' -e '.+' '\/tmp\/my dir\/compact\.flag'$/);
    expect(buildPostCompactHookCommand("/tmp/it's/compact.flag", 'linux', '/n'))
      .toContain(`'/tmp/it'"'"'s/compact.flag'`);
    const win = buildPostCompactHookCommand('C:\\Temp Folder\\compact.flag', 'win32', 'C:\\Program Files\\nodejs\\node.exe');
    expect(win).toMatch(/^"C:\\Program Files\\nodejs\\node\.exe" -e ".+" "C:\\Temp Folder\\compact\.flag"$/);
    expect(win).not.toContain('cat ');
  });

  it('writes the completion sentinel when executed from a temp dir containing spaces', async () => {
    const spaced = mkdtempSync(join(tmpdir(), 'metabot hook spaces '));
    cleanup.push(spaced);
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = spaced;
    const bridge = createHookBridge();
    try {
      const settingsPath = await bridge.writeSettings();
      expect(settingsPath.startsWith(spaced)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PostCompact: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      const [entry] = settings.hooks.PostCompact;
      expect(entry.matcher).toBe('manual');

      const completed = new Promise<void>(resolve => bridge.onCompactComplete?.(resolve));
      const payload = JSON.stringify({ hook_event_name: 'PostCompact', trigger: 'manual' });
      const result = await runHook(entry.hooks[0].command, payload);
      expect(result).toEqual({ code: 0, stderr: '' });
      expect(readFileSync(join(settingsPath, '..', 'compact.flag'), 'utf8')).toBe(payload);
      await completed;
    } finally {
      await bridge.dispose();
    }
  });
});
