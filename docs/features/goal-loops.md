# Goal Loops

## `/goal`

Send `/goal <condition>` to give the active agent an objective. Claude uses its
native goal mechanism; Codex uses MetaBot's existing bridge-managed goal loop.
The Feishu response card mirrors the condition as a persistent goal badge.

- `/goal status` shows the goal; `/goal clear` clears it without resetting the conversation.
- `/stop` aborts the current task and drains queued messages.
- `/reset` and its `/new` alias clear the execution session, queued messages,
  active goal and goal badge. The working directory stays unchanged.
- OSS session resets also clear the stored goal during internal recovery.

## `/auto [goal]`

Shadow Mode generates and visibly sends the next user message to the current
agent. It uses completed question/answer pairs, not tool traces, to decide what
to say next. Unlike `/goal`, it drives progress through new chat messages sent
as the host's authorized Feishu/Lark user.

| Command | Effect |
| --- | --- |
| `/auto` | Start immediately, even without a previous completed turn |
| `/auto <goal>` | Start with a goal, or replace the goal of your active run |
| `/auto status` | Show status without starting a run |
| `/auto stop` | Stop sending follow-up messages |

While active, ordinary messages are additional input, not a takeover. Their
completed responses join the trajectory and automatic advancement continues.
Only the run's initiating user can change its goal or stop it through `/auto`.
With a goal set, the Shadow model can signal that the goal is achieved and
verified; MetaBot then stops without sending another user message. This is a
model judgment, not independent verification. Without a goal there is no
automatic completion condition or fixed turn limit: monitor usage and stop it
explicitly. Normal engine permissions, approvals and budgets still apply.

### Setup And Privacy

`/auto` is disabled by default. Administrators must explicitly allow initiating
actors with `METABOT_AUTO_ALLOWED_USER_IDS` (comma-separated user IDs). Use it
only in trusted chats: those actors can drive the host's authorized user identity.

The channel must support sending as a user and know the current bot's open ID
for mentions. Delivery uses the host's separately authorized `lark-cli` user
session, respecting `LARK_CLI_PATH` when configured. An optional
`METABOT_SHADOW_USER_ACCESS_TOKEN` is a runtime-only alternative; never put it
in repository files, bot configuration, logs or messages. The token must belong
to the intended Feishu/Lark identity and have permission to send in the chat.
MetaBot does not install, update or reauthorize `lark-cli`.

Shadow generation uses an isolated session with no tools. An optional local
`.metabot/shadow-profile.md` under the bot's working directory can provide a
profile; do not place credentials in it. Shadow's own Q/A cache stays in memory
by default; the underlying engine may still retain generation prompts in its
normal session storage. Active runs do not survive restart. Thread replies
remain in their original Feishu/Lark thread.

## `/resume`

The picker shows relative time followed by the engine's session title. Untitled
sessions fall back to the first-prompt preview, then the session ID prefix. The
description retains the ID prefix, current-session marker and a distinct prompt
preview when available. `/resume <id-prefix>` still resumes directly by ID.
