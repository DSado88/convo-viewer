#!/bin/zsh
# Red/green test for the gloss-sync stale-lock bug and its hardened lock.
# Usage: lock-test.sh <path-to-sync-script>
# Runs the script with rsync stubbed out, across scenarios:
#   1. stale lock, no pidfile (the July 2026 real-world failure) -> must SYNC
#   2. stale lock, dead-pid pidfile                              -> must SYNC
#   3. recycled PID (live process, wrong command)                -> must SYNC
#   4. live lock (holder is a real *sync-to-* process, fresh)    -> must SKIP
#   5. no lock                                                   -> must SYNC, lock removed after
set -uo pipefail

SCRIPT="$1"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stub rsync so no network/filesystem traffic happens.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/rsync" <<'EOF'
#!/bin/zsh
echo "stub-rsync ran"
exit 0
EOF
chmod +x "$WORK/bin/rsync"
export PATH="$WORK/bin:$PATH"
export GLOSS_SYNC_STAMP="$WORK/last-success"
date +%s > "$GLOSS_SYNC_STAMP"   # fresh stamp so no staleness alerts fire in tests
LOCKDIR="$HOME/Library/Caches/gloss-sync.lock"
SAVED=""
[[ -d "$LOCKDIR" ]] && { SAVED="$WORK/saved-lock"; mv "$LOCKDIR" "$SAVED"; }
restore() { rm -rf "$LOCKDIR"; [[ -n "$SAVED" && -d "$SAVED" ]] && mv "$SAVED" "$LOCKDIR"; rm -rf "$WORK"; }
trap 'restore' EXIT

pass=0; fail=0
check() { # name expect_synced actual_output
  local name="$1" expect="$2" out="$3"
  local synced=no
  [[ "$out" == *"stub-rsync ran"* ]] && synced=yes
  if [[ "$synced" == "$expect" ]]; then
    echo "PASS: $name (synced=$synced)"; ((pass++))
  else
    echo "FAIL: $name (expected synced=$expect, got synced=$synced)"; echo "$out" | sed 's/^/    /'; ((fail++))
  fi
}

# 1. Stale lock, empty (no pidfile), OLD — the exact state left behind on July 20.
rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"; /usr/bin/touch -m -t 202601010000 "$LOCKDIR"
out="$(zsh "$SCRIPT" 2>&1)"
check "old empty lock reclaimed" yes "$out"

# 1b. Empty lock with FRESH mtime = another process mid-acquisition (between its
# mkdir and its pid write). Must NOT be stolen.
rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"
out="$(zsh "$SCRIPT" 2>&1)"
check "fresh empty lock skips (acquisition in progress)" no "$out"

# 2. Stale lock with a dead PID.
rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"
zsh -c 'echo $$ > '"$LOCKDIR"'/pid' # that zsh has already exited -> PID dead
out="$(zsh "$SCRIPT" 2>&1)"
check "stale dead-pid lock" yes "$out"

# 3. Recycled PID: process alive but is not a sync script -> reclaim.
rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"
sleep 300 </dev/null >/dev/null 2>&1 & imposter_pid=$!
echo "$imposter_pid" > "$LOCKDIR/pid"
out="$(zsh "$SCRIPT" 2>&1)"
kill "$imposter_pid" 2>/dev/null
check "recycled-pid lock reclaimed" yes "$out"

# 4. Live lock — holder is a genuine sync-to-* process.
rm -rf "$LOCKDIR"; mkdir "$LOCKDIR"
cat > "$WORK/fake-sync-to-live.sh" <<'EOF'
#!/bin/zsh
sleep 300
EOF
chmod +x "$WORK/fake-sync-to-live.sh"
zsh "$WORK/fake-sync-to-live.sh" </dev/null >/dev/null 2>&1 & live_pid=$!
echo "$live_pid" > "$LOCKDIR/pid"
out="$(zsh "$SCRIPT" 2>&1)"
kill "$live_pid" 2>/dev/null
check "live sync lock skips" no "$out"

# 5. No lock at all — normal run, and lock must be cleaned up afterward.
rm -rf "$LOCKDIR"
out="$(zsh "$SCRIPT" 2>&1)"
check "clean run" yes "$out"
if [[ -d "$LOCKDIR" ]]; then
  echo "FAIL: lock left behind after clean run"; ((fail++))
else
  echo "PASS: lock cleaned up after run"; ((pass++))
fi

# 6. rsync failure + stale stamp: must exit nonzero AND fire the staleness
# warning (a permanently-failing rsync must not be silent).
cat > "$WORK/bin/rsync" <<'EOF'
#!/bin/zsh
echo "stub-rsync failing" >&2
exit 1
EOF
rm -rf "$LOCKDIR"
echo $(( $(date +%s) - 7 * 3600 )) > "$GLOSS_SYNC_STAMP"   # 7h-old stamp
out="$(zsh "$SCRIPT" 2>&1)"; rc=$?
if (( rc != 0 )) && [[ "$out" == *"WARNING"* ]]; then
  echo "PASS: failing rsync exits nonzero with staleness warning"; ((pass++))
else
  echo "FAIL: failing rsync (rc=$rc, warning present: $([[ "$out" == *WARNING* ]] && echo yes || echo no))"
  echo "$out" | sed 's/^/    /'; ((fail++))
fi
if [[ -d "$LOCKDIR" ]]; then
  echo "FAIL: lock left behind after failed run"; ((fail++))
else
  echo "PASS: lock cleaned up after failed run"; ((pass++))
fi
# restore passing stub + fresh stamp for any later scenarios
cat > "$WORK/bin/rsync" <<'EOF'
#!/bin/zsh
echo "stub-rsync ran"
exit 0
EOF
date +%s > "$GLOSS_SYNC_STAMP"

echo "---"
echo "$pass passed, $fail failed"
exit $(( fail > 0 ))
