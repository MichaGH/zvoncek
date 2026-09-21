import { run } from "./db.mjs";
import { readFileSync } from "node:fs";
const src = readFileSync("C:/000_DEV/0_ZVONCEK/zvoncek/prisma/backfill/2026-09-assignments.ts", "utf8");
const POSITIVE = src.match(/const POSITIVE = `([^`]+)`/)[1].replace("'INTERESTED',", "");
let CLASSIFY = src.match(/const CLASSIFY_SQL = `([\s\S]+?)`;/)[1].replaceAll("${POSITIVE}", POSITIVE);
const withDeleted = CLASSIFY.replace(/WHERE l\."deletedAt" IS NULL(\r?\n\),)/, "$1");
if (withDeleted === CLASSIFY) throw new Error("deleted filter not found");
const sim = (x) => x.replaceAll('a."revertedAt"', 'NULL::timestamp').replaceAll('l."assignedCallerId"', 'NULL::text').replaceAll('l."pipelineEnteredAt"', 'NULL::timestamp').replaceAll('l."handedOffById"', 'NULL::text').replaceAll('l."closedAt"', 'NULL::timestamp').replace("IN ('PIPELINE', 'CLIENTS')", "IN ('PIPELINE')");
await run(async (c) => {
  const admin = (await c.query(`select id from "User" where role='ADMIN' and "deletedAt" is null`)).rows;
  if (admin.length !== 1) throw new Error("admin count " + admin.length);
  for (const [label, sql] of [["non-deleted (script as is)", sim(CLASSIFY)], ["incl. deleted (Q9)", sim(withDeleted)]]) {
    const rows = (await c.query(sql, [admin[0].id])).rows;
    const agg = {};
    for (const r of rows) { const k = r.class + " / " + r.status; agg[k] = (agg[k] ?? 0) + 1; }
    console.log("\n== " + label); console.table(Object.entries(agg).sort().map(([k, n]) => ({ k, n })));
    const bad = rows.filter(r => !["DEAL_OK","CALLWORK_OK","POOL","TERMINAL_OK","DEAL_TO_MIGRATE","CALLWORK_TO_MIGRATE","STRAY_ASSIGNMENT","DEAL_CLOSEDAT_FIX"].includes(r.class) || Number(r.matches) > 1);
    console.log("problem leads:", bad.map(r => `#${r.number} ${r.class} ${r.status} pos=${r.pos} anyCall=${r.any_call} dealAct=${r.deal_act}`));
  }
  // positive calls per lead >1 / deals with pos=0
  console.log((await c.query(`select l.number, l.status, count(*)::int pos from "Lead" l join "Activity" a on a."leadId"=l.id and a.type='CALL' and a.source='CALL_QUEUE' and a.outcome in ${POSITIVE} group by 1,2 having count(*)>1`)).rows);
  // reset lead detail
  console.log((await c.query(`select l.number, l.status, l."deletedAt" is not null del, (select string_agg(a.outcome::text||'@'||to_char(a."createdAt",'YYYY-MM-DD HH24:MI'), ', ' order by a."createdAt") from "Activity" a where a."leadId"=l.id and a.type='CALL') calls, (select to_char(max(a."createdAt"),'YYYY-MM-DD HH24:MI') from "Activity" a where a."leadId"=l.id and a.note like 'Vrátené do volaní%') reset_at, (select count(*)::int from "Activity" a where a."leadId"=l.id and a."createdAt" > (select max(b."createdAt") from "Activity" b where b."leadId"=l.id and b.note like 'Vrátené do volaní%')) acts_after from "Lead" l where exists (select 1 from "Activity" a where a."leadId"=l.id and a.note like 'Vrátené do volaní%')`)).rows);
  // call-stage leads carrying nextAction (V2: deal-only field)
  console.log((await c.query(`select status, count(*)::int n from "Lead" l where "nextActionKind" is not null and not exists (select 1 from "Activity" a where a."leadId"=l.id and a.type='CALL' and a.source='CALL_QUEUE' and a.outcome in ${POSITIVE}) group by 1`)).rows);
});
