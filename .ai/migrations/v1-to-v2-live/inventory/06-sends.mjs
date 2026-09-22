import { run } from "./db.mjs";
const day = (d) => d ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Bratislava" }).format(d) : null;
const POS = ["WANTS_QUOTE","WANTS_DESIGN","WANTS_EMAIL","POSITIVE"];
await run(async (c) => {
  const leads = (await c.query(`select id, number, status::text, "deletedAt" is not null del, price::text price, "priceNote" is not null has_pnote, "priceDisclosed" disc, "quoteSentAt" q, "aboutUsSentAt" ab, "designSentAt" ds, "nextActionKind"::text kind, "nextActionMode"::text mode, "nextActionAt" nat from "Lead"`)).rows;
  const acts = (await c.query(`select id, "leadId", type::text, source::text, outcome::text, note, "createdAt" at, "userId" from "Activity" order by "createdAt", id`)).rows;
  const designs = (await c.query(`select id, "leadId", "sentAt", "deletedAt" is not null del, "createdAt" from "Design"`)).rows;
  const byLead = new Map(); for (const a of acts) (byLead.get(a.leadId) ?? byLead.set(a.leadId, []).get(a.leadId)).push(a);
  const dByLead = new Map(); for (const d of designs) (dByLead.get(d.leadId) ?? dByLead.set(d.leadId, []).get(d.leadId)).push(d);
  const out = []; const flags = {};
  const flag = (k, n) => (flags[k] ??= []).push(n);
  for (const l of leads) {
    const A = byLead.get(l.id) ?? []; const D = dByLead.get(l.id) ?? [];
    const pos = A.some(a => a.type === "CALL" && a.source === "CALL_QUEUE" && POS.includes(a.outcome));
    const email = A.filter(a => a.type === "EMAIL_SENT"), quote = A.filter(a => a.type === "QUOTE_SENT"), dsent = A.filter(a => a.type === "DESIGN_SENT");
    const undoQ = A.filter(a => a.note === "Odoslanie cenovej ponuky zrušené"), undoD = A.filter(a => a.note === "Návrh označený ako neposlaný"), discA = A.filter(a => a.note === "Klient oboznámený s cenou");
    const priceNotes = A.filter(a => a.type === "CONTACT_UPDATED" && a.note?.startsWith("Cena:"));
    const any = email.length || quote.length || dsent.length || l.q || l.ab || l.ds || l.disc || l.price || D.length;
    if (!any) continue;
    const ev = [];
    // ABOUT
    for (const a of email) ev.push({ k: "ABOUT", at: a.at, src: a.id });
    if (l.ab && !email.length) { ev.push({ k: "ABOUT", at: l.ab, src: "field" }); flag("ABOUT_FIELD_ONLY", l.number); }
    if (l.ab && email.length && !email.some(a => Math.abs(a.at - l.ab) < 2000)) flag("ABOUT_FIELD_MISMATCH", l.number);
    if (email.length > 1) flag("EMAIL_SENT_MULTI", l.number);
    // CP with undo
    for (let i = 0; i < quote.length; i++) {
      const a = quote[i], next = quote[i + 1];
      const undone = undoQ.some(u => u.at > a.at && (!next || u.at < next.at));
      const amt = a.note?.match(/:\s*([\d.,]+)\s*€/)?.[1] ?? null;
      if (undone) { flag("CP_UNDONE", l.number); continue; }
      ev.push({ k: "CP", at: a.at, src: a.id, amt });
    }
    if (l.q && !quote.length) { ev.push({ k: "CP", at: l.q, src: "field" }); flag("CP_FIELD_ONLY", l.number); }
    if (!l.q && quote.length && !undoQ.length) flag("CP_NO_FIELD_NO_UNDO", l.number);
    // DESIGN
    const used = new Set();
    for (const d of D.filter(d => d.sentAt)) {
      const m = dsent.find(a => !used.has(a.id) && Math.abs(a.at - d.sentAt) < 2000);
      if (m) used.add(m.id); else flag("DESIGN_NO_ACTIVITY", l.number);
      if (d.del) flag("DESIGN_SENT_DELETED", l.number);
      ev.push({ k: "DESIGN", at: d.sentAt, src: d.id });
    }
    for (const a of dsent.filter(a => !used.has(a.id))) {
      const undone = undoD.some(u => u.at > a.at);
      flag(undone ? "DESIGN_ACT_UNDONE" : "DESIGN_ACT_UNMATCHED", l.number);
    }
    if (l.ds && !D.some(d => d.sentAt && !d.del)) flag("LEAD_DESIGNSENT_NO_DESIGN", l.number);
    // pricing
    const cp = ev.filter(e => e.k === "CP");
    if (l.price && !cp.length) {
      if (ev.some(e => e.k === "DESIGN")) flag("Q1B_DESIGN_PRICE_NO_CP", l.number);
      else if (ev.some(e => e.k === "ABOUT")) flag("Q1A_ABOUT_PRICE_NO_CP", l.number);
      else flag("PRICE_ONLY_NO_SEND", l.number);
    }
    for (const e of cp) {
      if (e.amt == null) flag("CP_NO_AMOUNT", l.number);
      else if (l.price == null) flag("CP_AMOUNT_BUT_PRICE_NULL", l.number);
      else if (Number(e.amt.replace(",", ".")) !== Number(l.price)) flag("CP_AMOUNT_DIFFERS", `${l.number}(${e.amt}→${l.price})`);
    }
    if (l.disc && !cp.length) flag(l.price ? "DISCLOSED_NO_CP_WITH_PRICE" : "DISCLOSED_NO_CP_NO_PRICE", l.number);
    if (discA.length) flag("DISCLOSED_MANUAL_TICK", l.number);
    if (priceNotes.length > 1) flag("PRICE_CHANGED_MULTI", l.number);
    const firstPrice = priceNotes[0]?.at;
    if (firstPrice && ev.some(e => e.at < firstPrice)) flag("SEND_BEFORE_PRICE_SET", l.number);
    if (ev.length && !pos) flag("SEND_ON_NON_DEAL", l.number);
    if (l.del && ev.length) flag("SEND_ON_DELETED", l.number);
    // grouping
    const days = {}; for (const e of ev) (days[day(e.at)] ??= []).push(e.k);
    const groups = Object.entries(days);
    for (const [, ks] of groups) if (ks.length > 1) flag("SAME_DAY_MERGE", `${l.number}(${ks.join("+")})`);
    // steps
    if (["ACTIVE","SNOOZED"].includes(l.status) && l.kind?.startsWith("SEND_")) {
      const want = { SEND_QUOTE: "CP", SEND_DESIGN: "DESIGN", SEND_EMAIL: "ABOUT" }[l.kind];
      const planning = A.filter(a => ["NEXT_ACTION_SET","NEXT_ACTION_CHANGED"].includes(a.type) && a.note?.startsWith(l.kind));
      const stepSetAt = planning.at(-1)?.at ?? null;
      const hasContent = ev.filter(e => e.k === want || (want === "ABOUT")); // every send carries Info
      const after = hasContent.some(e => stepSetAt && e.at >= stepSetAt);
      flag(`OPEN_${l.kind}_${hasContent.length ? (after ? "RECEIPT_AFTER_STEP" : "OLDER_RECEIPT_ONLY") : "NO_RECEIPT"}${stepSetAt ? "" : "_NO_STEP_ROW"}`, l.number);
    }
    out.push({ n: l.number, st: l.status, del: l.del, price: l.price, disc: l.disc, step: l.kind, sends: groups.map(([d, ks]) => `${d}:${ks.join("+")}`).join(" | ") });
  }
  console.log("leads with any send/price/design evidence:", out.length);
  console.table(out.filter(o => o.sends));
  console.log("no send events but price/disclosed/design rows:"); console.table(out.filter(o => !o.sends));
  console.log("\nFLAGS"); for (const [k, v] of Object.entries(flags).sort()) console.log(`  ${k.padEnd(34)} ${String(v.length).padStart(3)}  ${v.join(", ")}`);
});
