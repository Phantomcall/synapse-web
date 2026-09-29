#!/bin/sh
# Shared helpers for the Synapse Core pre-commit / pre-push hooks.
#
# Sourced (not executed) by .husky/pre-commit and .husky/pre-push. Husky v9
# treats any file in .husky/ whose name does not start with an underscore as a
# hook, so the leading `_` is what keeps this out of the hook set.
#
# The single thing this file exists for is the emergency bypass. See the
# "Git hooks" section of README.md for the policy; the short version is:
#
#   * Routine use:        commit and push normally. The hooks are the point.
#   * Emergency use:      SYNAPSE_HOOK_BYPASS="<reason>" git commit -m ...
#                         This is the *sanctioned* escape hatch. It requires a
#                         reason, it prints a loud reminder, and the reason has
#                         to be copied into the PR description so the bypass is
#                         attributable after the fact.
#   * Not sanctioned:     --no-verify / HUSKY=0. These skip the hook entirely,
#                         including this guard, so they are silent. Use them
#                         only if the hook is genuinely wedged (see README).
#
# Setting SYNAPSE_HOOK_BYPASS to the empty string is treated as a mistake rather
# than a bypass: an empty value is almost always someone half-remembering the
# incantation, and silently allowing it would defeat the point of requiring a
# reason. So we hard-fail and tell them what to do.

# synapse_bypass_guard <hook-name>
# Exits 0 to let the hook continue, or exits the process (0 = bypass honoured,
# 1 = empty reason supplied) if a bypass was requested.
synapse_bypass_guard() {
  _hook_name="$1"

  # `${VAR+x}` (rather than `-n "$VAR"`) so we can tell "unset" from "set but
  # empty" in POSIX sh.
  if [ "${SYNAPSE_HOOK_BYPASS+x}" = "x" ]; then
    if [ -z "$SYNAPSE_HOOK_BYPASS" ]; then
      echo "ERROR: SYNAPSE_HOOK_BYPASS is set but empty." >&2
      echo "" >&2
      echo "An empty reason is not a bypass. The whole point of the" >&2
      echo "emergency path is that it is attributable, so re-run with one:" >&2
      echo "" >&2
      echo "  SYNAPSE_HOOK_BYPASS=\"<why the hook cannot pass right now>\" git commit" >&2
      echo "" >&2
      echo "or fix the underlying problem and commit normally." >&2
      exit 1
    fi

    echo "" >&2
    echo "  ==============================================================" >&2
    echo "   BYPASSING THE ${_hook_name} HOOK" >&2
    echo "  ==============================================================" >&2
    echo "   reason: ${SYNAPSE_HOOK_BYPASS}" >&2
    echo "" >&2
    echo "   This will not be caught until CI runs, so the risk is yours." >&2
    echo "   Copy the reason above into the PR description and add a" >&2
    echo "   'Bypassed hooks' section to it. If CI goes red because of" >&2
    echo "   this, expect review to ask why." >&2
    echo "" >&2
    echo "   See 'Git hooks' in README.md for the full policy." >&2
    echo "  ==============================================================" >&2
    echo "" >&2
    exit 0
  fi
}

# synapse_die <hook-name> <commit|push> <message...>
# Uniform failure epilogue so a blocked commit/push always says what to do.
synapse_die() {
  _hook_name="$1"
  _verb="$2"
  shift 2
  echo "" >&2
  echo "  ${_hook_name} hook blocked this ${_verb}. -> $* " >&2
  echo "  (Or, for a genuine emergency: SYNAPSE_HOOK_BYPASS=\"<reason>\" ...)" >&2
  echo "" >&2
  exit 1
}
