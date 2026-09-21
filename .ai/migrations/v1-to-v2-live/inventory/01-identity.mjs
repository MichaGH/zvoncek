import { run, endpoint } from "./db.mjs";
await run(async (c) => {
  const i = (await c.query(`select current_database() db, current_setting('server_version') v, now() now, current_setting('transaction_read_only') ro`)).rows[0];
  console.log({ endpoint, ...i });
  const canary = (await c.query(`select number, (note ilike '%IF YOU SEE THIS%') as has_canary, "updatedAt" from "Lead" where number = 3237`)).rows;
  console.log("canary #3237:", canary);
  const t = (await c.query(`select table_name from information_schema.tables where table_schema='public' order by 1`)).rows.map(r=>r.table_name);
  console.log("tables:", t.join(", "));
});
