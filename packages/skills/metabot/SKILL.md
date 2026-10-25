---
name: metabot
description: "Unified MetaBot CLI for personal Memory, Skill Hub, durable Agent Bus messaging, agent registry, Agent Teams, T5T, scheduling, and bridge runtime operations."
---

# MetaBot Personal CLI Router

`metabot` is the single CLI for MetaBot Personal Edition. Legacy `mm`, `mh`,
and `mb` binaries are retired. This Skill documents CLI and durable-state
semantics only; project execution policy belongs in the workspace `AGENTS.md`.

## Command References

| Surface | Reference |
| --- | --- |
| Search, read, create, update, share, or delete Meta Memory | [`references/memory.md`](references/memory.md) |
| Browse, install, or publish a Skill | [`references/skills.md`](references/skills.md) |
| Inspect Agents or send durable Agent Bus messages | [`references/agents.md`](references/agents.md) |
| Coordinate an Agent Team | Use the separate `metabot-team` Skill |
| Read or write T5T status | [`references/t5t.md`](references/t5t.md) |
| Schedule work or inspect a runtime | [`references/runtime.md`](references/runtime.md) |

## Fast Path

```bash
metabot memory search "query"
metabot memory get <id|path>
metabot skills list
metabot agents list
metabot send <agentId> "message"
metabot send sessions <agentId> [--limit N] [--offset N]
metabot send history <sessionId> [--limit N] [--before <messageId>]
metabot teams status <team> --summary
metabot t5t push <project> <YYYY-MM-DD> "entry"
metabot health
```

Run `metabot help` or `metabot <surface> --help` before assuming an optional
bridge-local command is available.

## Authentication And Scope

- Personal Core defaults to `http://127.0.0.1:9200`.
- Override it with `METABOT_CORE_URL` for another user-configured Core.
- Use `METABOT_CORE_TOKEN`, or the first line of `~/.metabot-core/token`.
- `metabot agents whoami` shows the current Core identity.
- `metabot send` returns durable `messageId`, `sessionId`, and `runId` values;
  pass `--session` or `--idempotency-key` when a retry must target the same
  logical run.
- Bus session titles come from the first message (up to 40 characters).
  History and session selection require agent ownership or room membership;
  a visible agent does not make other users' sessions public.
- Pass `--sender-session <ownedSessionId>` to return terminal results to the
  sending session through normal Core run dispatch. Bound rooms also require
  sender membership. Success notices contain an 800-character excerpt;
  failures retain the full error. Both include a full-run-events pull hint.
  Notices omit a return-session ID to prevent reply loops.
- `--child-direct` explicitly opts into the target session's bound Feishu
  chat; sticky bindings alone never trigger presentation. `--implicit`
  disables target presentation, not an explicitly requested session return.
  Origin-proxy runs keep their existing projection path, without a second
  session notice; bridge support for that legacy path is separate.
- Project and global Skill destinations are distinct discovery scopes.
- MetaBot's own `metabot` and `metabot-team` bundles are global-only; project
  mirrors are retired outside discovery roots so stale copies cannot shadow
  updates.

## Output

Commands may return document IDs, paths, message IDs, Task IDs, Run IDs, and
session IDs. Preserve the identifiers needed for later inspection or recovery.
