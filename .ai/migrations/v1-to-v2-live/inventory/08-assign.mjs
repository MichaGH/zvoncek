import { run } from "./db.mjs";
await run(async (c) => {
  console.table((await c.query(`with lastq as (select distinct on (a."leadId") a."leadId", a."userId" from "Activity" a where a.type='CALL' and a.source='CALL_QUEUE' order by a."leadId", a."createdAt" desc, a.id desc)
    select u.role, l.status, l."callbackKind" ck, count(*)::int n from "Lead" l join lastq q on q."leadId"=l.id join "User" u on u.id=q."userId" where l.status in ('CALLING','SNOOZED') and not exists (select 1 from "Activity" p where p."leadId"=l.id and p.type='CALL' and p.outcome in ('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL','POSITIVE')) group by 1,2,3 order by 1,2,3`)).rows);
  console.table((await c.query(`select u.role, count(*)::int deals from "Activity" a join "User" u on u.id=a."userId" where a.type='CALL' and a.outcome in ('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL') group by 1`)).rows);
  console.table((await c.query(`select status, count(*)::int n, to_char(min("updatedAt"),'YYYY-MM-DD') oldest from "Lead" where status in ('WON','LOST','UNREACHABLE') and exists (select 1 from "Activity" p where p."leadId"="Lead".id and p.type='CALL' and p.outcome in ('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL')) and not exists (select 1 from "Activity" s where s."leadId"="Lead".id and s.type='STATUS_CHANGED') group by 1`)).rows);
});
