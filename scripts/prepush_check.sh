#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "running quick quality checks..."
uv run ruff format --check .
uv run ruff check .
uv run mypy

hook_mode=false
if [[ "${1:-}" == "--hook" ]]; then
  hook_mode=true
  shift
fi

changed_files=()
test_targets=()

add_changed_file() {
  local candidate="$1"
  local existing
  for existing in "${changed_files[@]:-}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return
    fi
  done
  changed_files+=("$candidate")
}

add_target() {
  local candidate="$1"
  local existing
  for existing in "${test_targets[@]:-}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return
    fi
  done
  test_targets+=("$candidate")
}

collect_changed_files_for_range() {
  local range="$1"
  local file
  while IFS= read -r file; do
    if [[ -n "$file" ]]; then
      add_changed_file "$file"
    fi
  done < <(git diff --name-only --diff-filter=ACDMRT "$range" 2>/dev/null || true)
}

is_zero_sha() {
  local sha="$1"
  [[ "$sha" =~ ^0+$ ]]
}

if [[ "$hook_mode" == "true" ]]; then
  while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
    if [[ -z "${local_ref:-}" ]]; then
      continue
    fi
    if is_zero_sha "$local_sha"; then
      continue
    fi
    if ! is_zero_sha "${remote_sha:-}"; then
      collect_changed_files_for_range "${remote_sha}..${local_sha}"
      continue
    fi
    if git show-ref --verify --quiet refs/remotes/origin/master; then
      base="$(git merge-base "$local_sha" origin/master || true)"
      if [[ -n "$base" ]]; then
        collect_changed_files_for_range "${base}..${local_sha}"
      fi
    fi
  done
else
  if git rev-parse --verify "@{upstream}" >/dev/null 2>&1; then
    collect_changed_files_for_range "@{upstream}..HEAD"
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    base="$(git merge-base HEAD origin/master || true)"
    if [[ -n "$base" ]]; then
      collect_changed_files_for_range "${base}..HEAD"
    fi
  fi
fi

for file in "${changed_files[@]:-}"; do
  case "$file" in
    bot/*.py)
      add_target "bot/tests"
      ;;
    presets/shared/preflight/*.py)
      add_target "bot/tests"
      ;;
    presets/shared/skills/push-and-pr/*)
      add_target "presets/shared/skills/push-and-pr/tests"
      ;;
    presets/shared/skills/post-pr/*)
      add_target "presets/shared/skills/post-pr/tests"
      ;;
    presets/shared/skills/auto-fork/*)
      add_target "presets/shared/skills/auto-fork/tests"
      ;;
    presets/workflows/*/skills/*/*)
      skill_test_dir="$(echo "$file" | sed -E 's|(presets/workflows/[^/]+/skills/[^/]+)/.*|\1|')/tests"
      if [[ -d "$skill_test_dir" ]]; then
        add_target "$skill_test_dir"
      fi
      ;;
    dashboard/*)
      add_target "dashboard"
      ;;
    proxy/executor/*)
      add_target "proxy/executor"
      ;;
    .claude/skills/*.py)
      add_target ".claude/skills/tests"
      ;;
  esac
done

if [[ ${#test_targets[@]} -eq 0 ]]; then
  echo "no mapped areas changed - skipping targeted tests"
  exit 0
fi

echo "running targeted tests:"
printf '  - %s\n' "${test_targets[@]}"

for target in "${test_targets[@]}"; do
  case "$target" in
    dashboard)
      (cd dashboard && npm test)
      ;;
    proxy/executor)
      (cd proxy/executor && go test -race ./...)
      ;;
    *)
      uv run pytest -q "$target"
      ;;
  esac
done
