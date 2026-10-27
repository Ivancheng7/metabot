import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const helper = resolve('scripts/node-runtime.sh');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'metabot-node-'));
  temporary.push(root);
  const bin = join(root, 'bridge-bin');
  const cursor = join(root, '.cursor', 'bin');
  mkdirSync(bin);
  mkdirSync(cursor, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho 10.0.0\n', { mode: 0o755 });
  writeFileSync(join(cursor, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  writeFileSync(join(cursor, 'npm'), '#!/bin/sh\nexit 98\n', { mode: 0o755 });
  const run = (extra: Record<string, string> = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; metabot_select_node "$2" || exit; node -e \'console.log(JSON.stringify({path:process.env.PATH,node:process.env.METABOT_NODE_PATH,target:process.env.npm_config_target}))\'',
        'bash',
        helper,
        root,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          METABOT_NODE_PATH: '',
          PATH: `${cursor}:${bin}:/usr/bin:/bin`,
          npm_config_target: '24.0.0',
          ...extra,
        },
      },
    );
  return { root, bin, run };
}

describe('bridge Node selection', () => {
  it('excludes Cursor node and npm and clears inherited native build targets', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(result.stdout);
    expect(selected.node).toBe(join(f.bin, 'node'));
    expect(selected.path).not.toContain('.cursor');
    expect(selected.target).toBeUndefined();
  });
  it('honors the deployment interpreter even when PATH names a different Node', () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'ecosystem.config.cjs'),
      `module.exports={apps:[{interpreter:${JSON.stringify(process.execPath)}}]}`,
    );
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).node).toBe(process.execPath);
  });
  it('fails closed for a missing explicitly pinned interpreter', () => {
    const f = fixture();
    const result = f.run({ METABOT_NODE_PATH: join(f.root, 'missing') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid bridge Node');
  });
  it('fails closed when the selected Node has no matching npm', () => {
    const f = fixture();
    const dir = join(f.root, 'no-npm');
    mkdirSync(dir);
    symlinkSync(process.execPath, join(dir, 'node'));
    const result = f.run({ METABOT_NODE_PATH: join(dir, 'node') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No matching npm');
  });
});
