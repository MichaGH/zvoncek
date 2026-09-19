// PRIPRAVENÁ ALTERNATÍVA k legacy vrstve (round 2 §2d, context/domain/db-changes.md §3.3) – zatiaľ sa NEPOUŽÍVA v rollout-e.
// Prevedie staré odoslania (starý systém: QUOTE_SENT / EMAIL_SENT / DESIGN_SENT, quoteSentAt, aboutUsSentAt,
// priceDisclosed, Design.sentAt, Lead.designSentAt) na skutočné OFFER_SENT záznamy s dátumami, aby app nepotrebovala
// „?", overovanie ani legacy vetvy. Nejasné prípady NIKDY neháda: vypíše ich a --apply sa odmietne, kým ich manažér
// nerozhodne v súbore s prepismi.
//
// Pravidlá (každý starý údaj → jedna udalosť; dátum = kedy sa to stalo):
//   EMAIL_SENT aktivita           → EMAIL {o nás} (+ cenník, ak je deň >= --pricelist-from)
//   QUOTE_SENT aktivita           → EMAIL {cena}, suma z poznámky „Cenová ponuka odoslaná: 599 €"; bez sumy = FLAG
//   aboutUsSentAt bez EMAIL_SENT  → EMAIL {o nás} k tomu dňu
//   quoteSentAt bez QUOTE_SENT    → EMAIL {cena} k tomu dňu so sumou Lead.price; bez ceny = FLAG
//   CP zrušená („Odoslanie cenovej ponuky zrušené" po poslednej QUOTE_SENT a quoteSentAt prázdne) = FLAG
//   priceDisclosed bez cenovej udalosti → TELEFÓN {cena} k dátumu „Klient oboznámený s cenou"; bez dátumu/ceny = FLAG
//   Design.sentAt (alebo legacySentAt) → EMAIL {návrh} s daným návrhom k tomu dňu
//   Lead.designSentAt bez jediného Design riadku → EMAIL {návrh} bez odkazu na návrh
// Záznamy dostanú meta.migrated = true (štatistiky ich vylúčia z porovnania prvého emailu) a createdAt = čas udalosti.
//
// Prepisy (--overrides súbor.json), kľúč = číslo obchodu:
//   { "412": { "skip": true } }                      – obchod neprevádzať (napr. testovací)
//   { "413": { "quotePrice": 690 } }                 – suma pre CP bez sumy (všetky jeho CP bez sumy)
//   { "414": { "dropCancelledQuote": true } }        – zrušenú CP vynechať (inak { "keepCancelledQuote": true })
//   { "415": { "disclosedOn": "2026-07-03", "disclosedPrice": 900 } } – telefonická cena bez dátumu/ceny
//
// Bezpečnosť ako ostatné backfilly: DRY-RUN predvolený (vypíše plán + --report CSV mimo repo); --apply len na DIRECT
// hoste s --confirm <endpoint>; --expect-endpoint/--expect-db; opakovateľný (obchod s migrated záznamom sa preskočí);
// --verify hlási staré údaje bez prevodu.
//
//   npx tsx prisma/backfill/2026-09-offer-migrate.ts --expect-endpoint ep-x --expect-db neondb --pricelist-from 2026-08-01 --report C:/tmp/plan.csv
//   npx tsx prisma/backfill/2026-09-offer-migrate.ts ... --overrides C:/tmp/overrides.json --apply --confirm ep-x
//   npx tsx prisma/backfill/2026-09-offer-migrate.ts ... --verify
import "dotenv/config";
import { writeFileSync, readFileSync } from "node:fs";
import prisma from "../../lib/db";
import { lockLeadRow, withLockTx } from "../../lib/access/locks";
import { businessDate, isValidBusinessDate } from "../../lib/domain/businessTime";
import { recomputeOffers } from "../../lib/domain/offerMutations";
import { moneyToString, offerNote, parseOfferMeta, type OfferContent, type OfferMeta } from "../../lib/domain/offers";

type Override = {
    skip?: boolean;
    quotePrice?: number;
    dropCancelledQuote?: boolean;
    keepCancelledQuote?: boolean;
    disclosedOn?: string;
    disclosedPrice?: number;
};

type PlannedEvent = {
    at: Date;
    channel: "EMAIL" | "PHONE";
    contents: OfferContent[];
    amount?: number;
    designs?: { id: string; label: string | null; url: string | null; version: number }[];
    from: string; // odkiaľ udalosť pochádza (id starej aktivity alebo pole)
};

type LeadPlan = { id: string; number: number; name: string; ownerId: string | null; events: PlannedEvent[]; flags: string[] };

const argv = process.argv.slice(2);
const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(n);
function fail(message: string): never {
    console.error(`ABORT: ${message}`);
    process.exit(1);
}

const expectEndpoint = arg("--expect-endpoint");
const expectDb = arg("--expect-db");
const pricelistFrom = arg("--pricelist-from");
const reportPath = arg("--report");
const overridesPath = arg("--overrides");
const apply = has("--apply");
const verify = has("--verify");

const url = new URL(process.env.DATABASE_URL ?? "postgres://x/none");
const label = url.hostname.split(".")[0];
const endpoint = label.replace(/-pooler$/, "");
const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!expectEndpoint || !expectDb || endpoint !== expectEndpoint || db !== expectDb) {
    fail("--expect-endpoint a --expect-db sa musia zhodovať s DATABASE_URL.");
}
if (apply && (label.endsWith("-pooler") || arg("--confirm") !== endpoint)) fail("--apply vyžaduje DIRECT host a --confirm <endpoint>.");
if (!verify && (!pricelistFrom || !isValidBusinessDate(pricelistFrom))) fail("Povinné --pricelist-from YYYY-MM-DD (od kedy emaily obsahovali cenník).");

const overrides: Record<string, Override> = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};

const AMOUNT = /(\d[\d\s]*(?:[.,]\d{1,2})?)\s*€/;
function parseAmount(note: string | null): number | null {
    const m = note?.match(AMOUNT);
    if (!m) return null;
    const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

// Obchody so starými údajmi, ktoré ešte nemajú prevedené (migrated) záznamy.
async function candidates() {
    return prisma.lead.findMany({
        where: {
            pipelineEnteredAt: { not: null },
            NOT: { activities: { some: { type: "OFFER_SENT", meta: { path: ["migrated"], equals: true } } } },
            OR: [
                { quoteSentAt: { not: null } },
                { aboutUsSentAt: { not: null } },
                { priceDisclosed: true },
                { designSentAt: { not: null } },
                { activities: { some: { type: { in: ["QUOTE_SENT", "EMAIL_SENT", "DESIGN_SENT"] } } } },
                { designs: { some: { OR: [{ sentAt: { not: null } }, { legacySentAt: { not: null } }] } } },
            ],
        },
        select: {
            id: true,
            number: true,
            companyName: true,
            website: true,
            ownerId: true,
            price: true,
            quoteSentAt: true,
            aboutUsSentAt: true,
            priceDisclosed: true,
            designSentAt: true,
            activities: {
                where: {
                    OR: [
                        { type: { in: ["QUOTE_SENT", "EMAIL_SENT", "DESIGN_SENT"] } },
                        { type: "CONTACT_UPDATED", note: { in: ["Odoslanie cenovej ponuky zrušené", "Klient oboznámený s cenou"] } },
                        { type: "OFFER_SENT" },
                    ],
                },
                orderBy: { createdAt: "asc" },
                select: { id: true, type: true, note: true, createdAt: true, meta: true },
            },
            designs: { select: { id: true, label: true, targetUrl: true, currentVersion: true, sentAt: true, legacySentAt: true, deletedAt: true } },
        },
    });
}

function plan(lead: Awaited<ReturnType<typeof candidates>>[number]): LeadPlan {
    const o = overrides[String(lead.number)] ?? {};
    const events: PlannedEvent[] = [];
    const flags: string[] = [];
    const price = lead.price != null ? Number(lead.price) : null;
    const acts = lead.activities;
    const inNew = new Set<string>();
    for (const a of acts) {
        if (a.type !== "OFFER_SENT") continue;
        for (const d of parseOfferMeta(a.meta)?.designs ?? []) inNew.add(d.id);
    }

    const emails = acts.filter((a) => a.type === "EMAIL_SENT");
    for (const a of emails) {
        const withList = businessDate(a.createdAt) >= pricelistFrom!;
        events.push({ at: a.createdAt, channel: "EMAIL", contents: withList ? ["ABOUT_US", "PRICELIST"] : ["ABOUT_US"], from: a.id });
    }
    if (!emails.length && lead.aboutUsSentAt) {
        const withList = businessDate(lead.aboutUsSentAt) >= pricelistFrom!;
        events.push({ at: lead.aboutUsSentAt, channel: "EMAIL", contents: withList ? ["ABOUT_US", "PRICELIST"] : ["ABOUT_US"], from: "Lead.aboutUsSentAt" });
    }

    const quotes = acts.filter((a) => a.type === "QUOTE_SENT");
    const lastQuote = quotes[quotes.length - 1];
    const cancelled = Boolean(
        lastQuote && !lead.quoteSentAt && acts.some((a) => a.note === "Odoslanie cenovej ponuky zrušené" && a.createdAt > lastQuote.createdAt),
    );
    for (const a of quotes) {
        if (a === lastQuote && cancelled) {
            if (o.dropCancelledQuote) continue;
            if (!o.keepCancelledQuote) {
                flags.push(`CP ${businessDate(a.createdAt)} bola potom zrušená – dropCancelledQuote / keepCancelledQuote`);
                continue;
            }
        }
        const amount = parseAmount(a.note) ?? o.quotePrice ?? null;
        if (amount === null) {
            flags.push(`CP ${businessDate(a.createdAt)} bez sumy – quotePrice`);
            continue;
        }
        events.push({ at: a.createdAt, channel: "EMAIL", contents: ["PRICE"], amount, from: a.id });
    }
    if (!quotes.length && lead.quoteSentAt) {
        const amount = price ?? o.quotePrice ?? null;
        if (amount === null) flags.push(`CP ${businessDate(lead.quoteSentAt)} bez ceny – quotePrice`);
        else events.push({ at: lead.quoteSentAt, channel: "EMAIL", contents: ["PRICE"], amount, from: "Lead.quoteSentAt" });
    }

    if (lead.priceDisclosed && !events.some((e) => e.contents.includes("PRICE"))) {
        const told = [...acts].reverse().find((a) => a.note === "Klient oboznámený s cenou");
        const at = o.disclosedOn ? new Date(`${o.disclosedOn}T10:00:00Z`) : told?.createdAt;
        const amount = o.disclosedPrice ?? price;
        if (!at) flags.push("„klient pozná cenu“ bez dátumu – disclosedOn");
        else if (amount === null) flags.push("„klient pozná cenu“ bez sumy – disclosedPrice");
        else events.push({ at, channel: "PHONE", contents: ["PRICE"], amount, from: told?.id ?? "Lead.priceDisclosed" });
    }

    const sentDesigns = lead.designs.filter((d) => !inNew.has(d.id) && (d.legacySentAt ?? d.sentAt));
    for (const d of sentDesigns) {
        events.push({
            at: (d.legacySentAt ?? d.sentAt)!,
            channel: "EMAIL",
            contents: ["DESIGN"],
            designs: [{ id: d.id, label: d.label, url: d.targetUrl, version: d.currentVersion }],
            from: `Design ${d.id}`,
        });
    }
    if (!lead.designs.length && lead.designSentAt) {
        events.push({ at: lead.designSentAt, channel: "EMAIL", contents: ["DESIGN"], designs: [], from: "Lead.designSentAt" });
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { id: lead.id, number: lead.number, name: lead.companyName ?? lead.website ?? "—", ownerId: lead.ownerId, events, flags };
}

function csv(plans: LeadPlan[]) {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = ["cislo;firma;udalosti;na_rozhodnutie"];
    for (const p of plans) {
        const ev = p.events
            .map((e) => `${businessDate(e.at)} ${e.channel === "PHONE" ? "tel." : "email"}: ${e.contents.join("+")}${e.amount != null ? ` ${e.amount} €` : ""}`)
            .join(" | ");
        rows.push([String(p.number), esc(p.name), esc(ev), esc(p.flags.join(" | "))].join(";"));
    }
    return rows.join("\n");
}

async function main() {
    console.log(`identity: endpoint=${endpoint} db=${db} host=${label.endsWith("-pooler") ? "pooler" : "direct"}`);
    const leads = await candidates();
    const plans = leads.filter((l) => !overrides[String(l.number)]?.skip).map(plan);
    const flagged = plans.filter((p) => p.flags.length);
    const events = plans.reduce((n, p) => n + p.events.length, 0);
    console.log(`obchody na prevod: ${plans.length} · udalosti: ${events} · na rozhodnutie: ${flagged.length}`);

    if (verify) {
        if (plans.length) {
            console.error(`VERIFY FAILED: ${plans.length} obchodov má staré údaje bez prevodu.`);
            process.exitCode = 1;
        } else console.log("VERIFY OK: všetky staré odoslania sú prevedené.");
        return;
    }
    for (const p of flagged) console.log(`  #${p.number} ${p.name}: ${p.flags.join(" | ")}`);
    if (reportPath) {
        writeFileSync(reportPath, csv(plans), "utf8");
        console.log(`report: ${reportPath}`);
    }
    if (!apply) {
        console.log("DRY-RUN: nič sa nezapísalo.");
        return;
    }
    if (flagged.length) fail(`${flagged.length} obchodov čaká na rozhodnutie (--overrides). Nič sa nezapísalo.`);

    let done = 0;
    for (const p of plans) {
        if (!p.events.length) continue;
        await withLockTx(async (tx) => {
            if (!(await lockLeadRow(tx, p.id))) return;
            const already = await tx.activity.count({ where: { leadId: p.id, type: "OFFER_SENT", meta: { path: ["migrated"], equals: true } } });
            if (already) return; // opakovaný beh
            const userId = p.ownerId ?? (await tx.user.findFirstOrThrow({ where: { role: "ADMIN", deletedAt: null }, select: { id: true } })).id;
            for (const e of p.events) {
                const meta: OfferMeta & { migrated: true; migratedFrom: string } = {
                    channel: e.channel,
                    contents: e.contents,
                    price: e.amount != null ? { amount: moneyToString(e.amount), note: null } : null,
                    ...(e.designs ? { designs: e.designs } : {}),
                    sentOn: businessDate(e.at),
                    historical: false,
                    correction: null,
                    migrated: true,
                    migratedFrom: e.from,
                };
                await tx.activity.create({
                    data: {
                        leadId: p.id,
                        userId,
                        type: "OFFER_SENT",
                        category: "BUSINESS",
                        source: "PIPELINE",
                        note: offerNote(meta),
                        meta,
                        createdAt: e.at,
                    },
                });
            }
            await recomputeOffers(tx, p.id);
        });
        done++;
    }
    console.log(`COMMITTED: ${done} obchodov prevedených.`);
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
