import { run } from "./db.mjs";
await run(async (c) => {
  console.log((await c.query(`select table_name, column_name, numeric_precision, numeric_scale, datetime_precision, data_type from information_schema.columns where table_schema='public' and (data_type like 'timestamp%' or data_type='numeric') and not (datetime_precision=3 and data_type='timestamp without time zone')`)).rows);
  const counts = {};
  for (const t of ["User","Team","Invite","Lead","Activity","Design","DesignVersion","Tracker","TrackerEvent"]) counts[t]=(await c.query(`select count(*)::int n from "${t}"`)).rows[0].n;
  console.log(counts);
  console.log((await c.query(`select role, (\"deletedAt\" is not null) deleted, count(*)::int from "User" group by 1,2 order by 1`)).rows);
  console.log((await c.query(`select t.name is not null has, t."leaderId" is not null leader, (select count(*)::int from "User" u where u."teamId"=t.id) members from "Team" t`)).rows);
});
