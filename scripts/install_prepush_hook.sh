#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
managed_call='bash "$repo_root/scripts/prepush_check.sh" --hook "$@"'
git_hooks_path="$(git config --path core.hooksPath || true)"
if [[ -n "$git_hooks_path" ]]; then
  if [[ "$git_hooks_path" != /* ]]; then
    hook_dir="$repo_root/$git_hooks_path"
  else
    hook_dir="$git_hooks_path"
  fi
else
  hook_dir="$(git rev-parse --git-path hooks)"
fi

mkdir -p "$hook_dir"
hook_path="$hook_dir/pre-push"

if [[ -f "$hook_path" ]] && ! grep -Fq "$managed_call" "$hook_path"; then
  echo "existing pre-push hook found at $hook_path"
  echo "refusing to overwrite unmanaged hook"
  echo "add this line to your existing hook instead:"
  echo "  $managed_call"
  exit 1
fi

cat >"$hook_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash "$repo_root/scripts/prepush_check.sh" --hook "$@"
EOF

chmod +x "$hook_path"
echo "installed pre-push hook at $hook_path"
