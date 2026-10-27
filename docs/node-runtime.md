# Node and npm during installation and updates

On Unix, MetaBot selects its own Node toolchain before installing dependencies.
Set `METABOT_NODE_PATH` to an absolute Node executable to select it explicitly.
Otherwise, the installer honors an absolute interpreter in the deployment's
`ecosystem.config.cjs`, then searches PATH outside Cursor-private directories.
The selected Node must be >=22.19.0 and have a matching npm in its bin directory.
No system-wide Node or npm installation is changed.

The native gate opens an in-memory SQLite database and starts a short PTY child.
If necessary, it rebuilds better-sqlite3 and node-pty once before rechecking.
Failure stops the installation/update before restarting the Bridge. This does
not make package overlays transactional: preserve a backup of a working install
and its user configuration before updating.

For manual npm maintenance:

```sh
bash scripts/with-system-node.sh npm install
METABOT_NODE_PATH=/absolute/node/bin/node bash scripts/with-system-node.sh npm rebuild
```

The portable PM2 configuration still uses `node`; no Linux-only absolute Node
path or fixed native ABI is enforced. Windows installation remains independent
of these Bash helpers. Existing user-selected engine integrations are preserved.
