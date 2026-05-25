#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
HARNESS_SKILL_NAME="harness-creator"
HARNESS_SKILL_REPO="walkinglabs/learn-harness-engineering"
HARNESS_SKILL_PATH="skills/harness-creator"
INSTALLER="$CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py"
HARNESS_DEST="$CODEX_HOME/skills/$HARNESS_SKILL_NAME"

echo "== SupaMail coding-agent skills =="

ensure_harness_creator() {
  if [[ -d "$HARNESS_DEST" ]]; then
    echo "$HARNESS_SKILL_NAME already installed at $HARNESS_DEST"
    return
  fi

  if [[ ! -f "$INSTALLER" ]]; then
    echo "Missing Codex skill installer: $INSTALLER" >&2
    echo "Install manually from https://github.com/$HARNESS_SKILL_REPO/tree/main/$HARNESS_SKILL_PATH" >&2
    exit 1
  fi

  python3 "$INSTALLER" --repo "$HARNESS_SKILL_REPO" --path "$HARNESS_SKILL_PATH"
}

ensure_skills_sh_skill() {
  local skill_name="$1"
  local codex_dest="$CODEX_HOME/skills/$skill_name"
  local agents_dest="$HOME/.agents/skills/$skill_name"

  if [[ -d "$codex_dest" ]]; then
    echo "$skill_name already installed at $codex_dest"
    return
  fi

  if [[ -d "$agents_dest" ]]; then
    echo "$skill_name already installed at $agents_dest"
    return
  fi

  echo "Installing official Supabase skill: $skill_name"
  npx --yes skills add supabase/agent-skills --skill "$skill_name" --agent codex --global --yes
}

ensure_harness_creator
ensure_skills_sh_skill "supabase"
ensure_skills_sh_skill "supabase-postgres-best-practices"

echo "Skill bootstrap complete."
echo "Restart Codex to pick up newly installed skills."
