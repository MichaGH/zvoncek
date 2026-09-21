#!/usr/bin/env bash
# Runs the complete V1 → V2 migration on ONE V1 target, in order, stopping at the first failure.
#
#   bash .ai/migrations/v1-to-v2-live/tools/run-migration.sh <ENV_VAR_NAME> <endpoint-id> [--production-window]
#
# Recipe and expected numbers: .ai/migrations/v1-to-v2-live/RECIPE.md.
# Resume: FROM=<n> after fixing the cause — ONLY at the step that failed. Steps 1, 11 are not re-runnable (schema);
# 5–7 need the V1 columns (before 11) and the old send rows (before 9); 10b removes the markers 7 and 10 rely on.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
VAR="$1"; EP="$2"; PW="${3:-}"; FROM="${FROM:-1}"
W=(node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --var "$VAR" --expect "$EP" $PW --)
D=.ai/migrations/v1-to-v2-live
NOISE='SSL modes|libpq|next major version|prepare for this change|explicitly use|uselibpqcompat|trace-warnings|libpq-ssl|npm notice|Loaded Prisma config|^$'
num() { local n="${1%% *}"; echo "${n//[a-z]/}"; }
stop() { echo "!!! STOP: $1"; exit 1; }
step() {
  local title="$1"; shift
  [ "$(num "$title")" -lt "$FROM" ] && return 0
  echo; echo "=== $title"
  "${W[@]}" "$@" 2>&1 | grep -Ev "$NOISE"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || stop "'$title' exited with $rc"
}
# Schema diff must be exactly the expected SQL statements (comments / blank lines / guard SELECTs ignored).
diff_is() {
  local title="$1" expected="$2"
  [ "$(num "$title")" -lt "$FROM" ] && return 0
  echo; echo "=== $title"
  local raw got rc
  raw=$("${W[@]}" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || stop "'$title' diff command failed ($rc)"
  got=$(printf '%s\n' "$raw" | grep -Ev '^--|^\s*$|^\[with-target\]|Loaded Prisma' | tr -s ' ' || true)
  echo "${got:-<empty>}"
  [ "$got" == "$expected" ] || stop "'$title' schema diff differs from the expected SQL"
  echo "OK: diff matches the expectation"
}
EXPECTED_DROPS=$(grep -Ev '^--|^\s*$|^SELECT' $D/sql/03-drop-v1-columns.sql | tr -s ' ')

step    "1  schema V1 → V2"              npx prisma db execute --file $D/sql/01-schema-v1-to-v2.sql
diff_is "1b diff = only the sql/03 drops" "$EXPECTED_DROPS"
step    "2  routing team Obchod"         npx prisma db execute --file $D/sql/02-obchod-team.sql
step    "3  assignments dry-run"         npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal
step    "4  assignments apply"           npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal --apply --confirm "$EP"
step    "4b assignments verify"          npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal --verify
step    "5  sends dry-run"               npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP"
step    "6  sends apply"                 npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP" --apply --confirm "$EP"
step    "7  sends verify"                npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP" --verify
step    "8  normalize dry-run"           npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP"
step    "9  normalize apply"             npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --apply --confirm "$EP"
step    "10 normalize verify"            npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --verify
step    "10b strip migration markers"    npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --strip --confirm "$EP"
step    "10c normalize verify again"     npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --verify
step    "11 drop dead V1 columns"        npx prisma db execute --file $D/sql/03-drop-v1-columns.sql
diff_is "12 diff = empty"                ""
step    "12b post-check"                 npx tsx $D/tools/post-check.ts
echo; echo "=== ALL STEPS PASSED on $EP"
