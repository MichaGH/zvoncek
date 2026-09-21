#!/usr/bin/env bash
# Runs the complete V1 → V2 migration on ONE target, in order, stopping at the first non-zero exit.
# Dry-runs are executed before every apply and printed; a script's own blocker check makes it exit non-zero.
#
#   bash .ai/migrations/v1-to-v2-live/tools/run-migration.sh <ENV_VAR_NAME> <endpoint-id> [--production-window]
#   e.g. bash .ai/migrations/v1-to-v2-live/tools/run-migration.sh MIGRATION_REHEARSAL_DATABASE_STD_URL ep-fragrant-sunset-aswxy5xw
#
# The target must be V1 (untouched copy of live, or live itself inside the approved window). Recipe: RECIPE.md.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
VAR="$1"; EP="$2"; PW="${3:-}"; FROM="${FROM:-1}"  # FROM=7 resumes at step 7 (steps are idempotent)
W=(node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --var "$VAR" --expect "$EP" $PW --)
NOISE='SSL modes|libpq|next major version|prepare for this change|explicitly use|uselibpqcompat|trace-warnings|libpq-ssl|npm notice|Loaded Prisma config|^$'
step() {
  local title="$1"; shift
  local n="${title%% *}"; n="${n%b}"; [ "$n" -lt "$FROM" ] && return 0
  echo; echo "=== $title"
  "${W[@]}" "$@" 2>&1 | grep -Ev "$NOISE"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then echo "!!! STOP: '$title' exited with $rc"; exit "$rc"; fi
}
D=.ai/migrations/v1-to-v2-live
step "1  schema V1 → V2"                npx prisma db execute --file $D/sql/01-schema-v1-to-v2.sql
step "1b diff (expect only sql/03 drops)" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
step "2  routing team Obchod"           npx prisma db execute --file $D/sql/02-obchod-team.sql
step "3  assignments dry-run"           npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal
step "4  assignments apply"             npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal --apply --confirm "$EP"
step "4b assignments verify"            npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint "$EP" --expect-db neondb --owner-username michal --verify
step "5  sends dry-run"                 npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP"
step "6  sends apply"                   npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP" --apply --confirm "$EP"
step "7  sends verify"                  npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint "$EP" --verify
step "8  normalize dry-run"             npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP"
step "9  normalize apply"               npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --apply --confirm "$EP"
step "10 normalize verify"              npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint "$EP" --verify
step "11 drop dead V1 columns"          npx prisma db execute --file $D/sql/03-drop-v1-columns.sql
step "12 diff (expect empty)"           npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
step "12b post-check"                   npx tsx $D/tools/post-check.ts
echo; echo "=== ALL STEPS PASSED on $EP"
