# Goal-driven `/auto` (Feishu and Lark)

`/auto <goal>` asks a separate, fresh generation turn to propose the next user
message from the recent question/answer trajectory. It sends that message as the
authorized user and mentions the bot. Human messages remain ordinary queued
input; they do not cancel the automation. With a goal, the generator stops once
it judges the goal complete. Always inspect its final results yourself.

This user-identity capability is **disabled by default**. The deployment owner
must explicitly configure `METABOT_AUTO_ALLOWED_USER_IDS` with the comma-separated
Feishu/Lark user IDs permitted to start it. The bot must have a discovered bot
identity, and user-managed `lark-cli` must already be authorized to send messages
as the intended user. `LARK_CLI_PATH` may select that installation. MetaBot does
not install, log in, or grant permissions to Lark tooling for this feature.

Commands:

- `/auto <goal>` starts automation, or updates the initiating user's goal.
- `/auto` starts without an explicit goal.
- `/auto status` reports state without starting automation.
- `/auto stop` stops future generated messages; an already submitted message
  cannot be unsent. Use `/stop` separately to cancel an active bot task.

Only the user who activated a run can change its goal or stop it. Activation
does not survive a Bridge restart. Recent automation context is kept in memory,
not a separate transcript file. An optional local `.metabot/shadow-profile.md`
under the bot working directory can guide the generator.

This is not a sandbox or a substitute for reviewing external actions: generated
messages drive the configured engine with that engine's existing tool permissions.
Do not enable it for untrusted group participants or unattended high-impact tasks.
