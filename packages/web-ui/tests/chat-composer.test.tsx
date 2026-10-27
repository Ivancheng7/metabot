import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyModelCommand, COMMON_MODELS, DEFAULT_MODELS, ENGINE_OPTIONS,
  loadModelChoice, parseModelCommand, saveModelChoice,
} from '../src/components/chat/model-command';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
});

afterEach(() => vi.unstubAllGlobals());

describe('public composer model choices', () => {
  it('keeps all three public engines and excludes Cursor', () => {
    expect(ENGINE_OPTIONS.map((option) => option.value)).toEqual(['claude', 'codex', 'kimi']);
    expect(Object.keys(COMMON_MODELS).sort()).toEqual(['claude', 'codex', 'kimi']);
    expect(DEFAULT_MODELS).toEqual({ claude: '', codex: 'gpt-6.1-sol', kimi: 'kimi-code/k3.1-pro' });
  });

  it('adds Codex and Kimi candidates without removing public options', () => {
    expect(COMMON_MODELS.codex).toEqual(expect.arrayContaining(['', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5']));
    expect(COMMON_MODELS.kimi).toEqual(expect.arrayContaining([
      '', 'kimi-code/k3.1-pro', 'kimi-code/k3.1-pro-highspeed', 'kimi-for-coding', 'kimi-k2',
    ]));
    expect(COMMON_MODELS.claude).toEqual(['', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6']);
  });

  it('parses engine switches, explicit models, lists and reset aliases', () => {
    expect(parseModelCommand('/MODEL Claude')).toEqual({ kind: 'engine', engine: 'claude' });
    expect(parseModelCommand('/model kimi')).toEqual({ kind: 'engine', engine: 'kimi' });
    expect(parseModelCommand('/model codex')).toEqual({ kind: 'engine', engine: 'codex' });
    expect(parseModelCommand('/model custom-model')).toEqual({ kind: 'model', model: 'custom-model' });
    expect(parseModelCommand('/model LIST')).toEqual({ kind: 'list' });
    for (const alias of ['reset', 'clear', 'default']) expect(parseModelCommand(`/model ${alias}`)).toEqual({ kind: 'reset' });
    expect(parseModelCommand('/modelx kimi')).toBeNull();
    expect(parseModelCommand('hello /model')).toBeNull();
  });

  it('changes models only when an explicit command requests it', () => {
    const current = { engine: 'codex' as const, model: 'profile-selected-model' };
    expect(applyModelCommand(current, '/model')).toEqual(current);
    expect(applyModelCommand(current, '/model kimi')).toEqual({ engine: 'kimi', model: 'kimi-code/k3.1-pro' });
    expect(applyModelCommand(current, '/model claude')).toEqual({ engine: 'claude', model: '' });
    expect(applyModelCommand(current, '/model reset')).toEqual({ engine: 'codex', model: 'gpt-6.1-sol' });
    expect(applyModelCommand(current, 'hello')).toBeNull();
  });

  it('preserves custom models, explicit engine defaults and Claude preferences', () => {
    saveModelChoice('custom', { engine: 'codex', model: 'profile-selected-model' });
    saveModelChoice('default', { engine: 'kimi', model: '' });
    saveModelChoice('claude', { engine: 'claude', model: 'my-claude-model' });
    expect(loadModelChoice('custom')).toEqual({ engine: 'codex', model: 'profile-selected-model' });
    expect(loadModelChoice('default')).toEqual({ engine: 'kimi', model: '' });
    expect(loadModelChoice('claude')).toEqual({ engine: 'claude', model: 'my-claude-model' });
    expect(loadModelChoice('other')).toEqual({ engine: 'codex', model: '' });
  });

  it('falls back safely for malformed or unavailable storage', () => {
    storage.set('metabot-core-chat-model:bad', '{');
    expect(loadModelChoice('bad')).toEqual({ engine: 'codex', model: '' });
    vi.stubGlobal('window', { localStorage: {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    } });
    expect(loadModelChoice('missing')).toEqual({ engine: 'codex', model: '' });
    expect(() => saveModelChoice('missing', { engine: 'kimi', model: '' })).not.toThrow();
  });
});
