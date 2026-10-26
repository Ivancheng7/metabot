import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { IncomingMessage } from '../types.js';
import type { Logger } from '../utils/logger.js';

export interface ShadowTurn {
  user: string;
  agent: string;
}

export interface ShadowModeDeps {
  generate: (chatId: string, prompt: string) => Promise<string | undefined>;
  deliver: (chatId: string, text: string, idempotencyKey: string) => Promise<string | undefined>;
  notice: (chatId: string, title: string, content: string, color?: string) => Promise<void>;
  logger?: Logger;
  profilePath: string;
  targetMention: () => string;
  statePath?: string;
}

interface ShadowState {
  enabled: boolean;
  ownerId: string;
  goal?: string;
  turns: ShadowTurn[];
  outboundMessageIds: Set<string>;
  activationId: string;
  sequence: number;
  generating: boolean;
  deliveryReceiptPending: boolean;
  inboundWhileReceiptPending: Set<string>;
}

const MAX_TRAJECTORY_BYTES = 128 * 1024;

export class ShadowMode {
  private destroyed = false;
  private readonly states = new Map<string, ShadowState>();
  private readonly recentTurns = new Map<string, ShadowTurn[]>();

  constructor(private readonly deps: ShadowModeDeps) {
    this.loadRecentTurns();
  }

  async command(msg: IncomingMessage, args: string): Promise<void> {
    if (this.destroyed) return;
    const action = args.trim();
    const existing = this.states.get(msg.chatId);
    if (action.toLowerCase() === 'status') {
      await this.deps.notice(
        msg.chatId,
        'Shadow Mode',
        existing?.enabled
          ? `运行中 · 已生成 ${existing.sequence} 条用户消息。${existing.goal ? `\n目标：${existing.goal}` : ''}`
          : 'Shadow 当前未运行。',
        'blue',
      );
      return;
    }
    if (existing?.enabled && existing.ownerId !== msg.userId) {
      await this.deps.notice(msg.chatId, 'Shadow Mode', '只有本次 /auto 的发起者可以修改目标或停止；可用 `/auto status` 查看状态。', 'orange');
      return;
    }
    if (action.toLowerCase() === 'stop') {
      const stopped = this.stop(msg.chatId);
      await this.deps.notice(
        msg.chatId,
        'Shadow Mode',
        stopped ? 'Shadow 已停止；不会再代你发送下一轮消息。' : 'Shadow 当前未运行。',
        'orange',
      );
      return;
    }
    const goal = action || undefined;
    if (existing?.enabled) {
      if (goal) {
        existing.goal = goal;
        await this.deps.notice(msg.chatId, 'Shadow Mode', `目标已更新：${goal}`, 'blue');
        return;
      }
      await this.deps.notice(
        msg.chatId,
        'Shadow Mode',
        `运行中 · 已生成 ${existing.sequence} 条用户消息。${existing.goal ? `\n目标：${existing.goal}` : ''}`,
        'blue',
      );
      return;
    }
    const state: ShadowState = {
      enabled: true,
      ownerId: msg.userId,
      goal,
      turns: [],
      outboundMessageIds: new Set(),
      activationId: randomUUID(),
      sequence: 0,
      generating: false,
      deliveryReceiptPending: false,
      inboundWhileReceiptPending: new Set(),
    };
    this.states.set(msg.chatId, state);
    const recent = this.recentTurns.get(msg.chatId);
    if (recent) state.turns.push(...recent);
    await this.deps.notice(
      msg.chatId,
      'Shadow Mode 已开启',
      `${goal ? `目标：${goal}\n` : ''}\`/auto stop\` 可停止。运行中你发送的消息会作为插入信息汇入上下文，不会打断 Shadow；Shadow 会根据每轮最终 Q/A 代你发送下一句并 @ 当前 Agent。`,
      'green',
    );
    await this.advance(msg.chatId, state);
  }

  observeInbound(msg: IncomingMessage): boolean {
    if (this.destroyed) return false;
    const state = this.states.get(msg.chatId);
    if (!state?.enabled || msg.userId !== state.ownerId) return false;
    if (state.outboundMessageIds.delete(msg.messageId)) return false;
    if (state.deliveryReceiptPending) {
      state.inboundWhileReceiptPending.add(msg.messageId);
      return false;
    }
    void this.deps
      .notice(msg.chatId, 'Shadow Mode', '已收到你的插入信息；Shadow 会继续自动推进，`/auto stop` 可停止。', 'blue')
      .catch(() => {});
    return true;
  }

  async observeFinal(chatId: string, user: string, agent: string): Promise<void> {
    if (this.destroyed) return;
    const turn = { user: user.trim(), agent: agent.trim() || '[Agent produced no textual final response]' };
    if (!turn.user) return;
    const state = this.states.get(chatId);
    const turns = state?.enabled ? state.turns : [...(this.recentTurns.get(chatId) ?? [])];
    turns.push(turn);
    this.trim(turns);
    this.recentTurns.set(chatId, [...turns]);
    this.saveRecentTurns();
    if (!state?.enabled) return;
    await this.advance(chatId, state);
  }

  stop(chatId: string): boolean {
    const state = this.states.get(chatId);
    if (!state) return false;
    const wasEnabled = state.enabled;
    state.enabled = false;
    state.outboundMessageIds.clear();
    state.deliveryReceiptPending = false;
    state.inboundWhileReceiptPending.clear();
    return wasEnabled;
  }

  stopAll(): void {
    for (const chatId of this.states.keys()) this.stop(chatId);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopAll();
    this.states.clear();
    this.recentTurns.clear();
  }

  private async advance(chatId: string, state: ShadowState): Promise<void> {
    if (!state.enabled || state.generating) return;
    state.generating = true;
    const sequence = state.sequence + 1;
    try {
      const generated = await this.deps.generate(chatId, this.buildPrompt(state));
      if (!state.enabled) return;
      const stopReason = state.goal && generated ? this.parseStopSignal(generated) : undefined;
      if (stopReason !== undefined) {
        this.stop(chatId);
        await this.deps.notice(
          chatId,
          'Shadow Mode 已自动停止',
          `目标已达成${stopReason ? `：${stopReason}` : '，Shadow 不会再发送下一轮消息。'}`,
          'green',
        );
        return;
      }
      const next = this.normalizeGeneratedMessage(generated);
      if (!next) {
        this.stop(chatId);
        await this.deps.notice(chatId, 'Shadow Mode 已停止', 'Shadow 未生成下一条用户消息。', 'red');
        return;
      }
      const message = `${this.deps.targetMention()}${next.trim()}`;
      state.deliveryReceiptPending = true;
      state.inboundWhileReceiptPending.clear();
      let messageId: string | undefined;
      try {
        messageId = await this.deps.deliver(chatId, message, this.deliveryIdempotencyKey(state, sequence));
      } finally {
        state.deliveryReceiptPending = false;
      }
      if (!state.enabled) return;
      if (!messageId) {
        this.stop(chatId);
        await this.deps.notice(chatId, 'Shadow Mode 已停止', '未能以用户身份发送下一轮消息。', 'red');
        return;
      }
      state.sequence = sequence;
      const inboundAlreadySeen = state.inboundWhileReceiptPending.delete(messageId);
      if (!inboundAlreadySeen) state.outboundMessageIds.add(messageId);
      state.inboundWhileReceiptPending.clear();
    } finally {
      state.generating = false;
    }
  }

  private normalizeGeneratedMessage(value: string | undefined): string | undefined {
    const text = value?.trim();
    if (!text) return undefined;
    if (text.startsWith('/')) {
      this.deps.logger?.warn(
        { generated: text.slice(0, 120) },
        'Shadow generated a control command; using safe continuation',
      );
      return '请继续按当前目标推进，并在完成后给出可验证的结果。';
    }
    return text;
  }

  private parseStopSignal(value: string): string | undefined {
    const match = /^(?:<shadow-stop>([\s\S]*?)<\/shadow-stop>|<shadow-stop\s*\/>)$/.exec(value.trim());
    return match ? (match[1]?.trim() ?? '') : undefined;
  }

  private deliveryIdempotencyKey(state: ShadowState, sequence: number): string {
    return `shadow-${createHash('sha256').update(`${state.activationId}:${sequence}`).digest('hex').slice(0, 40)}`;
  }

  private buildPrompt(state: ShadowState): string {
    const profile = this.readProfile();
    const trajectory = state.turns.map((turn) => `User: ${turn.user}\nAgent: ${turn.agent}`).join('\n\n');
    return [
      profile ? `<shadow-profile>\n${profile}\n</shadow-profile>` : '',
      state.goal ? `<goal>\n${state.goal}\n</goal>` : '',
      trajectory
        ? ['<trajectory>', trajectory, '</trajectory>'].join('\n')
        : '<activation>/auto 已由用户开启。直接输出第一条应以该用户身份发送给当前 Agent 的接管消息。</activation>',
      state.goal
        ? '直接输出下一条要以用户身份发送给 Agent 的消息，持续推进 <goal> 中的目标。若根据轨迹判断目标已完全达成且结果已验证，不要输出用户消息，只输出一行 `<shadow-stop>达成依据简述</shadow-stop>` 来结束本次 /auto。普通消息不得以 / 开头；不要解释、不要 JSON、不要 Markdown 标记。'
        : '直接输出下一条要以用户身份发送给 Agent 的消息。不得以 / 开头；不要解释、不要 JSON、不要 Markdown 标记。',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private readProfile(): string {
    try {
      return fs
        .readFileSync(path.resolve(this.deps.profilePath), 'utf8')
        .trim()
        .slice(0, 8 * 1024);
    } catch {
      return '';
    }
  }

  private trim(turns: ShadowTurn[]): void {
    while (turns.length > 1 && this.trajectoryBytes(turns) > MAX_TRAJECTORY_BYTES) turns.shift();
  }

  private trajectoryBytes(turns: ShadowTurn[]): number {
    return Buffer.byteLength(turns.map((turn) => `User: ${turn.user}\nAgent: ${turn.agent}`).join('\n\n'), 'utf8');
  }

  private loadRecentTurns(): void {
    if (!this.deps.statePath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8')) as {
        recent?: Record<string, ShadowTurn | ShadowTurn[]>;
      };
      for (const [chatId, value] of Object.entries(data.recent ?? {})) {
        const candidates = Array.isArray(value) ? value : [value];
        const turns = candidates.filter(
          (turn): turn is ShadowTurn => typeof turn?.user === 'string' && typeof turn.agent === 'string',
        );
        this.trim(turns);
        if (turns.length > 0) this.recentTurns.set(chatId, turns);
      }
    } catch {
    }
  }

  private saveRecentTurns(): void {
    if (!this.deps.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
      fs.writeFileSync(this.deps.statePath, JSON.stringify({ recent: Object.fromEntries(this.recentTurns) }), {
        mode: 0o600,
      });
    } catch {
    }
  }
}
