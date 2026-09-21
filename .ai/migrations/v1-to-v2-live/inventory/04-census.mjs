import { run } from "./db.mjs";
const q = async (c, label, sql) => { const r = (await c.query(sql)).rows; console.log("\n== " + label); console.table(r); };
await run(async (c) => {
  await q(c, "leads by status x deleted", `select status, ("deletedAt" is not null) del, count(*)::int n, count(*) filter (where "ownerId" is null)::int no_owner from "Lead" group by 1,2 order by 1,2`);
  await q(c, "activities by type/source", `select type, source, category, count(*)::int n from "Activity" group by 1,2,3 order by 1,2`);
  await q(c, "CALL outcomes by source", `select source, outcome, count(*)::int n from "Activity" where type='CALL' group by 1,2 order by 1,2`);
  await q(c, "users owning / acting", `select u.role, (select count(*)::int from "Lead" l where l."ownerId"=u.id) owned, (select count(*)::int from "Activity" a where a."userId"=u.id) acts from "User" u order by 1`);
  await q(c, "nextActionKind on non-NEW", `select status, "nextActionKind", "nextActionMode", count(*)::int n from "Lead" where "deletedAt" is null and status<>'NEW' group by 1,2,3 order by 1,2,3`);
  await q(c, "send fields", `select count(*) filter (where "aboutUsSentAt" is not null)::int about, count(*) filter (where "quoteSentAt" is not null)::int quote, count(*) filter (where "priceDisclosed")::int disclosed, count(*) filter (where price is not null)::int price, count(*) filter (where "priceNote" is not null)::int pnote, count(*) filter (where "designSentAt" is not null)::int design, count(*) filter (where "designUrl" is not null)::int designurl, count(*) filter (where "lockedById" is not null)::int locked from "Lead"`);
  await q(c, "designs", `select ("deletedAt" is not null) del, ("sentAt" is not null) sent, count(*)::int n from "Design" group by 1,2`);
  await q(c, "audit notes (send-related)", `select type, note, count(*)::int n from "Activity" where type in ('CONTACT_UPDATED','TRACKER_UPDATED','STATUS_CHANGED','OUTCOME_CORRECTED') and (note ilike '%cenov%' or note ilike '%oboznám%' or note ilike '%neposlan%' or note ilike '%Vrátené%' or type='OUTCOME_CORRECTED' or type='STATUS_CHANGED') group by 1,2 order by 1,3 desc limit 40`);
  await q(c, "price-change notes count", `select count(*)::int n, count(distinct "leadId")::int leads from "Activity" where type='CONTACT_UPDATED' and note like 'Cena:%'`);
  await q(c, "QUOTE_SENT notes", `select (note ~ '\d') has_amount, count(*)::int n from "Activity" where type='QUOTE_SENT' group by 1`);
  await q(c, "EMAIL_SENT/DESIGN_SENT notes", `select type, note is not null has_note, count(*)::int n from "Activity" where type in ('EMAIL_SENT','DESIGN_SENT','SMS_SENT','NOTE') group by 1,2`);
});
