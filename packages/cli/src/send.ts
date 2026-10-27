import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfig, parseArgs, print } from '@xvirobotics/cli-core';

// Personal Edition default: local Core. Set METABOT_CORE_URL for a hosted
// Core chosen by the operator.
const DEFAULT_CORE_URL = 'http://localhost:9200';

interface CoreConfig {
  url: string;
  token: string;
}

function readTokenFile(): string {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.metabot-core', 'token'), 'utf8');
    return raw.split(/\r?\n/)[0]?.trim() || '';
  } catch {
    return '';
  }
}

function loadCoreConfig(): CoreConfig {
  const envUrl = (process.env.METABOT_CORE_URL || process.env.METABOT_CORE_AGENT_BUS_URL || '').trim();
  const envToken = (process.env.METABOT_CORE_TOKEN || '').trim();
  if (envUrl || envToken) {
    const token = envToken || readTokenFile();
    if (!token) {
      throw new Error(
        'no token configured - set METABOT_CORE_TOKEN env var, or write the token to ~/.metabot-core/token',
      );
    }
    return { url: (envUrl || DEFAULT_CORE_URL).replace(/\/+$/, ''), token };
  }
  const cfg = loadConfig();
  return { url: cfg.url, token: cfg.token };
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatSessionCandidates(parsed: unknown): string {
  if (typeof parsed !== 'object' || !parsed || !Array.isArray((parsed as { sessions?: unknown }).sessions)) return '';
  const sessions = (parsed as { sessions: unknown[] }).sessions;
  const lines = sessions
    .filter((session): session is Record<string, unknown> => !!session && typeof session === 'object')
    .map(
      (session) =>
        `  ${String(session.id ?? '?')}  ${String(session.status ?? '?')}  ${String(session.updatedAt ?? '')}${session.title ? `  ${String(session.title)}` : ''}`,
    );
  return lines.length ? `\ncandidate sessions (pick one with --session <id>):\n${lines.join('\n')}` : '';
}

async function coreRequest<T = unknown>(cfg: CoreConfig, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.url}/api/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = await parseResponse(res);
  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    throw new Error(`metabot-core POST /api/messages -> ${res.status}: ${errMsg}${formatSessionCandidates(parsed)}`);
  }
  return parsed as T;
}

export function usage(): string {
  return `metabot send - minimal durable Agent Bus message

Usage:
  metabot send <agentId> "<message>" [options]
  metabot send sessions <agentId> [--limit N] [--offset N]
  metabot send history <sessionId> [--limit N] [--before <messageId>]

Options:
  --session <sessionId>                  Target an exact authorized Bus session.
  --implicit                             Do not present the target run in a chat.
  --origin-chat <oc_...> --origin-bot <name>
                                         Project progress to the origin chat.
  --child-direct                         Opt in to the target session's bound chat.
  --reply-to <messageId>                 Attach an optional reply reference.
  --sender-session <sessionId>            Return results to an owned sender session.
  --idempotency-key <key>                Deduplicate retries.

Core resolves the target Agent and session. Session history requires ownership
or room membership; agent visibility alone does not grant conversation access.
`;
}

async function runRead(cfg: CoreConfig, command: 'sessions' | 'history', args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  if (!positional[0])
    throw new Error(`metabot send ${command}: <${command === 'sessions' ? 'agentId' : 'sessionId'}> required`);
  const url = new URL(`${cfg.url}/api/messages/${command}`);
  url.searchParams.set(command === 'sessions' ? 'agentId' : 'sessionId', positional[0]);
  for (const flag of command === 'sessions' ? ['limit', 'offset'] : ['limit', 'before']) {
    const value = flags[flag];
    if (typeof value === 'string' && value.trim()) url.searchParams.set(flag, value.trim());
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' } });
  const parsed = await parseResponse(res);
  if (!res.ok) {
    const error = typeof parsed === 'object' && parsed && 'error' in parsed ? String(parsed.error) : String(parsed);
    throw new Error(`metabot-core GET /api/messages/${command} -> ${res.status}: ${error}`);
  }
  print(parsed);
}

export async function run(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  if (args[0] === 'sessions' || args[0] === 'history') return runRead(loadCoreConfig(), args[0], args.slice(1));
  const { positional, flags } = parseArgs(args);
  const agentId = positional[0];
  const message = positional[1];
  if (!agentId || !message) throw new Error('metabot send: <agentId> "<message>" required');

  const body: Record<string, unknown> = { agentId, message };
  const implicit = flags.implicit === true;
  const childDirect = flags['child-direct'] === true || flags.direct === true;
  const originChatId =
    typeof flags['origin-chat'] === 'string'
      ? flags['origin-chat'].trim()
      : (process.env.METABOT_ORIGIN_CHAT || '').trim();
  const originBotName =
    typeof flags['origin-bot'] === 'string'
      ? flags['origin-bot'].trim()
      : (process.env.METABOT_ORIGIN_BOT || '').trim();
  if (implicit) {
    body.presentationMode = 'implicit';
  } else if (childDirect) {
    body.presentationMode = 'child-direct';
  } else if (originChatId && originBotName) {
    body.presentationMode = 'origin-proxy';
    body.originChatId = originChatId;
    body.originBotName = originBotName;
  }
  for (const [flag, field] of [
    ['session', 'sessionId'],
    ['reply-to', 'replyTo'],
    ['sender-session', 'senderSessionId'],
    ['idempotency-key', 'idempotencyKey'],
  ] as const) {
    if (typeof flags[flag] === 'string' && flags[flag].trim()) body[field] = flags[flag].trim();
  }
  print(await coreRequest(loadCoreConfig(), body));
}
