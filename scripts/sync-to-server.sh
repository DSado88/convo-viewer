#!/bin/zsh
# Sync Claude Code JSONL logs from this machine to a remote Gloss server.
#
# Safety properties (do not "optimize" these away):
#   -a               preserves mtimes — canonical ranking tiebreaks depend on them
#   --delay-updates  every changed file lands via atomic rename at the END of the
#                    transfer, so the server's Gloss never sees a half-copied file
#   --partial-dir    interrupted transfers resume without corrupting targets
#   --timeout=300    a blackholed TCP link must not hold the lock forever —
#                    macOS's default TCP keepalive is ~2h, longer than any
#                    reasonable lock-staleness cap
#   NO --inplace / --append   would write into live files non-atomically
#   NO --delete               a bad local state must never erase server history
#
# Configuration (env):
#   GLOSS_SYNC_DEST   required — rsync destination, e.g.
#                     user@100.x.y.z:/Users/user/.claude/projects-laptop/
#                     Point it at a DEDICATED root on the server (not the
#                     server's own ~/.claude/projects) so source attribution
#                     stays correct; the server lists it in GLOSS_PROJECTS_ROOTS.
#   GLOSS_SYNC_SRC    optional — defaults to ~/.claude/projects/
#
# Usage: sync-to-server.sh [--dry-run]

set -euo pipefail

if [[ -z "${GLOSS_SYNC_DEST:-}" ]]; then
  echo "GLOSS_SYNC_DEST is not set (e.g. user@server:/path/to/projects-laptop/)" >&2
  exit 1
fi
SRC="${GLOSS_SYNC_SRC:-$HOME/.claude/projects/}"
DEST="$GLOSS_SYNC_DEST"
LOG_TAG="gloss-sync"

DRY_RUN=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=(--dry-run --verbose)
fi
# ${arr:+...} guard: empty-array expansion errors under `set -u` in bash <4.4

# Last-success stamp: the one signal that distinguishes "sync is healthy" from
# "sync has been silently skipping for a week" (July 2026: eight days undetected
# because every skip exited 0 and launchd saw success).
STAMP="${GLOSS_SYNC_STAMP:-$HOME/Library/Caches/gloss-sync.last-success}"
alert_if_stale() {
  local last age
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - last ))
  if (( age > 6 * 3600 )); then
    echo "[$LOG_TAG] WARNING: no successful sync in ${age}s" >&2
    osascript -e 'display notification "gloss-sync has not succeeded in over 6 hours" with title "Gloss sync stale"' 2>/dev/null || true
  fi
}

# One sync at a time — overlapping runs would race each other on the same
# remote partial dirs. Design notes (each guards a real observed/reviewed flaw):
#   - Fixed path, NOT $TMPDIR: launchd, cron, ssh, and sudo contexts can carry
#     different TMPDIRs, which would give each context its own lock.
#   - Holder PID + command check: EXIT traps don't fire on SIGKILL/sleep-kill,
#     so a dead holder must be reclaimed or every run skips forever. The command
#     check (not just kill -0) means a recycled PID can't wedge us, and a live
#     legit sync is never evicted just for being slow.
#   - Reclaim via atomic mv: two contenders can't both "win" — the loser's mv
#     fails instead of rm -rf'ing the winner's fresh lock.
#   - Ownership-checked trap: an evicted holder must not delete its successor's
#     lock on exit.
#   - Age cap (generous, with rsync --timeout making runaway holders finite):
#     final backstop if a recycled PID happens to match the command pattern.
LOCKDIR="$HOME/Library/Caches/gloss-sync.lock"
PIDFILE="$LOCKDIR/pid"
MAX_LOCK_AGE_SECS=$((6 * 3600))
is_sync_proc() { ps -p "$1" -o command= 2>/dev/null | grep -q "sync-to-"; }
ACQUIRE_GRACE_SECS=60
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  holder="$(cat "$PIDFILE" 2>/dev/null || true)"
  # /usr/bin/stat: PATH may resolve to GNU stat, whose -f means filesystem
  lock_mtime="$(/usr/bin/stat -f %m "$LOCKDIR" 2>/dev/null || echo 0)"
  lock_age=$(( $(date +%s) - lock_mtime ))
  # A young empty lock is a holder mid-acquisition (between its mkdir and its
  # pid write), not an abandoned one — without this grace the empty-holder path
  # would steal it, bypassing the age gate entirely.
  if [[ -z "$holder" ]] && (( lock_age < ACQUIRE_GRACE_SECS )); then
    echo "[$LOG_TAG] lock is being acquired, skipping" >&2
    alert_if_stale
    exit 0
  fi
  if [[ -n "$holder" ]] && is_sync_proc "$holder" && (( lock_age < MAX_LOCK_AGE_SECS )); then
    echo "[$LOG_TAG] another sync is running (pid $holder), skipping" >&2
    alert_if_stale
    exit 0
  fi
  if ! mv "$LOCKDIR" "$LOCKDIR.stale.$$" 2>/dev/null; then
    echo "[$LOG_TAG] lost race reclaiming lock, skipping" >&2
    alert_if_stale
    exit 0
  fi
  echo "[$LOG_TAG] reclaimed stale lock (holder ${holder:-unknown}, age ${lock_age}s)" >&2
  rm -rf "$LOCKDIR.stale.$$"
  if ! mkdir "$LOCKDIR" 2>/dev/null; then
    echo "[$LOG_TAG] lost race re-acquiring lock, skipping" >&2
    alert_if_stale
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
trap '[[ "$(cat "$PIDFILE" 2>/dev/null)" == "$$" ]] && rm -rf "$LOCKDIR"' EXIT

RSYNC_SSH=(-e "ssh -o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=5")

# `|| sync_failed=1` (not bare set -e death): a permanently-failing rsync must
# still reach alert_if_stale, or broken SSH auth becomes another silent outage.
sync_failed=0
rsync -a \
  --timeout=300 \
  "${RSYNC_SSH[@]}" \
  --delay-updates \
  --partial-dir=.rsync-partial \
  --exclude='subagents/' \
  --exclude='.rsync-partial/' \
  --exclude='.DS_Store' \
  ${DRY_RUN:+"${DRY_RUN[@]}"} \
  "$SRC" "$DEST" || sync_failed=1

if (( sync_failed )); then
  echo "[$LOG_TAG] $(date '+%Y-%m-%d %H:%M:%S') sync FAILED" >&2
  alert_if_stale
  exit 1
fi

date +%s > "$STAMP"
echo "[$LOG_TAG] $(date '+%Y-%m-%d %H:%M:%S') sync complete"
