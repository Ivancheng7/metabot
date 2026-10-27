export type ChatEngine = 'claude' | 'kimi' | 'codex';

export interface EngineOption {
  value: ChatEngine;
  label: string;
}

export const ENGINE_OPTIONS: EngineOption[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'kimi', label: 'Kimi' },
];

export const COMMON_MODELS: Record<ChatEngine, string[]> = {
  claude: ['', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
  codex: [
    '', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-astra-pro', 'gpt-5.6-sol',
    'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-codex', 'gpt-5.2-codex',
  ],
  kimi: [
    '', 'kimi-code/k3.1-pro', 'kimi-code/k3.1-pro-highspeed', 'kimi-code/k3',
    'kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed', 'kimi-for-coding', 'kimi-k2',
  ],
};

export const DEFAULT_ENGINE: ChatEngine = 'codex';
export const DEFAULT_MODELS: Record<ChatEngine, string> = {
  claude: '',
  codex: 'gpt-6.1-sol',
  kimi: 'kimi-code/k3.1-pro',
};

export type ModelCommand =
  | { kind: 'list' }
  | { kind: 'reset' }
  | { kind: 'engine'; engine: ChatEngine }
  | { kind: 'model'; model: string };

export function parseModelCommand(content: string): ModelCommand | null {
  const match = content.trim().match(/^\/model(?:\s+(.+))?$/i);
  if (!match) return null;
  const argument = (match[1] || '').trim();
  const normalized = argument.toLowerCase();
  if (!argument || normalized === 'list') return { kind: 'list' };
  if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') return { kind: 'reset' };
  if (normalized === 'claude' || normalized === 'kimi' || normalized === 'codex') {
    return { kind: 'engine', engine: normalized };
  }
  return { kind: 'model', model: argument.split(/\s+/)[0] };
}

export interface ModelChoice {
  engine: ChatEngine;
  model: string;
}

export function defaultModelChoice(engine: ChatEngine = DEFAULT_ENGINE): ModelChoice {
  return { engine, model: DEFAULT_MODELS[engine] };
}

export function applyModelCommand(current: ModelChoice, content: string): ModelChoice | null {
  const command = parseModelCommand(content);
  if (!command) return null;
  switch (command.kind) {
    case 'list': return current;
    case 'reset': return defaultModelChoice();
    case 'engine': return defaultModelChoice(command.engine);
    case 'model': return { engine: current.engine, model: command.model };
  }
}

function storageKey(conversationId: string): string {
  return `metabot-core-chat-model:${conversationId}`;
}

export function loadModelChoice(conversationId: string): ModelChoice {
  try {
    const raw = window.localStorage.getItem(storageKey(conversationId));
    if (!raw) return { engine: DEFAULT_ENGINE, model: '' };
    const parsed = JSON.parse(raw) as { engine?: string; model?: string };
    if (parsed.engine !== 'claude' && parsed.engine !== 'kimi' && parsed.engine !== 'codex') {
      return { engine: DEFAULT_ENGINE, model: '' };
    }
    return {
      engine: parsed.engine,
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { engine: DEFAULT_ENGINE, model: '' };
  }
}

export function saveModelChoice(conversationId: string, choice: ModelChoice): void {
  try {
    window.localStorage.setItem(storageKey(conversationId), JSON.stringify(choice));
  } catch {
    return;
  }
}
