#!/usr/bin/env bash
# Source this before dependency operations. Keep the bridge toolchain separate
# from agent-private Node distributions (Cursor includes its own Node).
metabot_select_node() {
  local target="${1:-$METABOT_HOME}" selected="${METABOT_NODE_PATH:-}" configured="" dir clean=""
  local -a dirs
  IFS=: read -r -a dirs <<< "$PATH"
  for dir in "${dirs[@]}"; do
    case "$dir" in *[Cc]ursor*) continue ;; esac
    [[ -n "$dir" ]] && clean="${clean:+$clean:}$dir"
  done
  if [[ -f "$target/ecosystem.config.cjs" ]]; then
    configured=$(PATH="$clean" node -e 'const a=require(process.argv[1]).apps[0]; process.stdout.write(a.exec_interpreter || a.interpreter || "node")' "$target/ecosystem.config.cjs") || return 1
  fi
  if [[ -z "$selected" && "$configured" == /* ]]; then selected="$configured"; fi
  if [[ -z "$selected" ]]; then selected=$(PATH="$clean" command -v node) || return 1; fi
  if [[ "$selected" != /* || ! -x "$selected" ]]; then
    echo "Invalid bridge Node executable: $selected (set METABOT_NODE_PATH to an absolute path)" >&2
    return 1
  fi
  # Require an ordinary Node installation with its matching npm. Using another
  # installation's npm can require a newer Node than the bridge supports.
  dir=$(dirname "$selected")
  if [[ ! -x "$dir/npm" ]]; then
    echo "No matching npm beside $selected; install Node with npm or set METABOT_NODE_PATH" >&2
    return 1
  fi
  export METABOT_NODE_PATH="$selected" PATH="$dir:$clean"
  hash -r
  "$selected" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22 || (major===22 && minor<19)) {console.error("MetaBot requires Node >=22.19");process.exit(1)}' || return 1
  # Do not inherit an agent/Electron cross-compilation target.
  unset npm_config_target npm_config_runtime npm_config_nodedir npm_config_disturl
  unset NPM_CONFIG_TARGET NPM_CONFIG_RUNTIME NPM_CONFIG_NODEDIR NPM_CONFIG_DISTURL
  npm --version >/dev/null || return 1
  echo "MetaBot toolchain: $selected ($("$selected" --version)), npm $(command -v npm)" >&2
}

metabot_verify_native() {
  local target="${1:-$METABOT_HOME}"
  [[ -f "$target/scripts/check-native.cjs" ]] || { echo "Missing native module probe in $target" >&2; return 1; }
  if ! (cd "$target" && "$METABOT_NODE_PATH" scripts/check-native.cjs); then
    echo 'Repairing native dependencies for the selected bridge Node...' >&2
    (cd "$target" && npm rebuild better-sqlite3 node-pty --build-from-source && "$METABOT_NODE_PATH" scripts/check-native.cjs) || return 1
  fi
}
