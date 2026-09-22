import { run } from "./db.mjs";
await run(async (c) => {
  const cols = (await c.query(`select table_name t, column_name c, udt_name ty, is_nullable n, column_default d from information_schema.columns where table_schema='public' order by table_name, ordinal_position`)).rows;
  let cur=""; for (const r of cols) { if (r.t!==cur){cur=r.t; console.log("\n#"+cur);} console.log(`  ${r.c} ${r.ty} ${r.n==='YES'?'?':''} ${r.d??''}`); }
  const en = (await c.query(`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) v from pg_type t join pg_enum e on e.enumtypid=t.oid group by 1 order by 1`)).rows;
  console.log("\nENUMS"); for (const e of en) console.log(" ", e.typname, e.v);
  const ix = (await c.query(`select indexdef from pg_indexes where schemaname='public' order by tablename, indexname`)).rows;
  console.log("\nINDEXES"); for (const i of ix) console.log(" ", i.indexdef.replace(/ USING btree/,'').replace(/public\./g,''));
  const fk = (await c.query(`select conrelid::regclass t, pg_get_constraintdef(oid) d from pg_constraint where contype='f' and connamespace='public'::regnamespace order by 1`)).rows;
  console.log("\nFKS"); for (const f of fk) console.log(" ", f.t, f.d);
  const ext = (await c.query(`select extname from pg_extension`)).rows.map(r=>r.extname); console.log("\nEXT", ext.join(","));
  const other = (await c.query(`select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and c.relkind in ('v','m','S') `)).rows; console.log("OTHER RELS", other);
  const trg = (await c.query(`select tgname, tgrelid::regclass from pg_trigger where not tgisinternal`)).rows; console.log("TRIGGERS", trg);
  const sz = (await c.query(`select relname, n_live_tup from pg_stat_user_tables order by 1`)).rows; console.log("ROWS(est)", sz.map(r=>r.relname+"="+r.n_live_tup).join(" "));
});
