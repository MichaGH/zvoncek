// Jednorazový prevod starých odoslaní V1 → kanonické OFFER_SENT (V1 → V2 rollout).
// Špecifikácia: .ai/migrations/v1-to-v2-live/02-data-mapping.md (§2–§5, §9) + DECISIONS.md D-003 r2 (Michal 2026-09-21).
//
//   EMAIL_SENT                              → Info (ABOUT_US)
//   QUOTE_SENT (nezrušená), suma z poznámky → Info + Cena (suma, ktorú CP vtedy niesla)
//   Design.sentAt (nezmazaný, spárovaný s DESIGN_SENT) → Info + Návrh
//   staré odoslania toho istého obchodného dňa → JEDEN záznam (zjednotený obsah)
//   rozhodnutia pre konkrétne obchody: #628 Info + Cena 499 € (cena išla v tom emaili); #98 bez ceny; #404 suma z CP
//
// Všetko ostatné sa NEHÁDA: každý iný vzor (odoslanie len v stĺpci, CP bez sumy, nespárovaný návrh, zmazaný poslaný
// návrh, odoslanie mimo obchodu / na zmazanom leade, cena bez CP na inom obchode, iná suma CP než cena…) je BLOKER a
// beh skončí pred akýmkoľvek zápisom. Takéto prípady rozhoduje Michal, nie skript.
//
// Záznam: createdAt = pôvodný čas V1, historical: false (správa sa ako bežné odoslanie), meta.migrated + provenancia v
// meta.migration (kľúč, zdroje). Staré zdrojové riadky zmaže až 2026-09-v2-normalize.ts. Aktér = autor najstaršej zdrojovej
// aktivity. Lead.price / priceNote / krok / stav sa nemenia; súhrny prepočíta recomputeOffers (revízia +1 raz).
// Opakovateľný: kľúč v2mig:offer:<leadId>:<sentOn>; existujúci zhodný záznam sa preskočí, odlišný = bloker.
//
// Bezpečnosť: spúšťa sa cez .ai/migrations/v1-to-v2-live/tools/with-target.mjs (DATABASE_URL nikdy v príkaze).
// DRY-RUN predvolený; --apply vyžaduje --confirm <endpoint>; --verify porovná DB s plánom. Produkčný endpoint len
// v schválenom okne (ZVONCEK_PRODUCTION_WINDOW nastaví wrapper s --production-window).
//
//   node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --expect ep-x -- npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint ep-x
//   … --apply --confirm ep-x
//   … --verify
import "dotenv/config";
import prisma from "../../lib/db";
import { lockLeadRow, withLockTx } from "../../lib/access/locks";
import { businessDate } from "../../lib/domain/businessTime";
import { recomputeOffers } from "../../lib/domain/offerMutations";
import { moneyToString, OFFER_CONTENTS, offerNote, parseOfferMeta, type OfferContent, type OfferMeta } from "../../lib/domain/offers";

const RULE = "D-003r2";
const UNDO_CP = "Odoslanie cenovej ponuky zrušené";
const UNSEND_DESIGN = "Návrh označený ako neposlaný";
// Rozhodnutia Michala 2026-09-21 (INVENTORY-2026-09-21.md): číslo obchodu → čo robiť s cenou bez CP / inou sumou.
const PRICE_WITH_ABOUT_US: Record<number, true> = { 628: true }; // cena išla v úvodnom emaili (suma = aktuálna cena)
const PRICE_ONLY_NOT_SENT: Record<number, true> = { 98: true, 916: true }; // cena len vyplnená, klient ju nedostal
const CP_AMOUNT_DIFFERS_OK: Record<number, true> = { 404: true }; // klient dostal sumu z CP, nie dnešnú cenu

type Args = { expectEndpoint?: string; confirm?: string; apply: boolean; verify: boolean };
function parseArgs(argv: string[]): Args {
    const a: Args = { apply: false, verify: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => {
            const v = argv[++i];
            if (!v || v.startsWith("--")) fail(`Chýba hodnota pre ${k}`);
            return v;
        };
        if (k === "--expect-endpoint") a.expectEndpoint = next();
        else if (k === "--confirm") a.confirm = next();
        else if (k === "--apply") a.apply = true;
        else if (k === "--verify") a.verify = true;
        else fail(`Neznámy argument: ${k}`);
    }
    return a;
}
function fail(msg: string): never {
    console.error(`ABORT: ${msg}`);
    process.exit(1);
}

type Planned = {
    leadId: string;
    number: number;
    key: string;
    sentOn: string;
    createdAt: Date;
    userId: string;
    meta: OfferMeta;
};

async function plan(migratedAt: string): Promise<{ events: Planned[]; blockers: string[]; notes: string[] }> {
    const leads = await prisma.lead.findMany({
        select: {
            id: true, number: true, deletedAt: true, pipelineEnteredAt: true, price: true, priceNote: true,
            designSentAt: true,
            activities: {
                where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT", "CONTACT_UPDATED", "TRACKER_UPDATED"] } },
                select: { id: true, type: true, note: true, userId: true, createdAt: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
            designs: { select: { id: true, label: true, targetUrl: true, currentVersion: true, sentAt: true, deletedAt: true } },
        },
        orderBy: { number: "asc" },
    });
    // Staré stĺpce V1 (quoteSentAt / aboutUsSentAt) nie sú v Prisma schéme V2 (zmažú sa na konci okna) – číta ich surové SQL.
    const v1 = new Map(
        (await prisma.$queryRaw<{ id: string; quoteSentAt: Date | null; aboutUsSentAt: Date | null }[]>`
            SELECT id, "quoteSentAt", "aboutUsSentAt" FROM "Lead"`).map((r) => [r.id, r]),
    );
    // Po prevode prepočet nastaví Design.sentAt na čas spoločného emailu, takže druhý návrh toho istého emailu sa môže
    // posunúť o pár sekúnd. Pár (návrh ↔ DESIGN_SENT) z už zapísaného prevodu preto platí aj mimo 2 s okna.
    const pairedByMigration = new Set<string>();
    for (const a of await prisma.activity.findMany({ where: { type: "OFFER_SENT" }, select: { meta: true } })) {
        const m = parseOfferMeta(a.meta)?.migration;
        for (const d of m?.designIds ?? []) for (const src of m?.sources ?? []) pairedByMigration.add(`${d}|${src}`);
    }
    const events: Planned[] = [];
    const blockers: string[] = [];
    const notes: string[] = [];

    for (const lead of leads) {
        const l = { ...lead, quoteSentAt: v1.get(lead.id)?.quoteSentAt ?? null, aboutUsSentAt: v1.get(lead.id)?.aboutUsSentAt ?? null };
        const email = l.activities.filter((a) => a.type === "EMAIL_SENT");
        const quote = l.activities.filter((a) => a.type === "QUOTE_SENT");
        const dsent = l.activities.filter((a) => a.type === "DESIGN_SENT");
        const undoCp = l.activities.filter((a) => a.note === UNDO_CP);
        const unsend = l.activities.filter((a) => a.note === UNSEND_DESIGN);
        const sentDesigns = l.designs.filter((d) => d.sentAt);
        const price = l.price != null ? Number(l.price) : null;
        const hasEvidence = email.length || quote.length || dsent.length || l.aboutUsSentAt || l.quoteSentAt || l.designSentAt || sentDesigns.length;
        const n = `#${l.number}`;
        if (!hasEvidence) {
            if (price != null && !PRICE_ONLY_NOT_SENT[l.number]) blockers.push(`${n}: cena bez akéhokoľvek odoslania (nie je v rozhodnutiach)`);
            continue;
        }
        if (l.deletedAt) { blockers.push(`${n}: odoslanie na zmazanom leade`); continue; }
        if (!l.pipelineEnteredAt) { blockers.push(`${n}: odoslanie na leade mimo obchodov (pipelineEnteredAt NULL)`); continue; }
        if (unsend.length) blockers.push(`${n}: návrh bol v V1 odznačený ako neposlaný`);
        if (l.aboutUsSentAt && !email.length) blockers.push(`${n}: aboutUsSentAt bez EMAIL_SENT`);
        if (l.quoteSentAt && !quote.length) blockers.push(`${n}: quoteSentAt bez QUOTE_SENT`);

        type Ev = { kind: "ABOUT" | "CP" | "DESIGN"; at: Date; userId: string; sources: string[]; amount?: string; design?: (typeof l.designs)[number] };
        const evs: Ev[] = email.map((a) => ({ kind: "ABOUT", at: a.createdAt, userId: a.userId, sources: [a.id] }));
        for (let i = 0; i < quote.length; i++) {
            const a = quote[i];
            const next = quote[i + 1];
            if (undoCp.some((u) => u.createdAt > a.createdAt && (!next || u.createdAt < next.createdAt))) continue; // zrušená (Q4)
            const amt = a.note?.match(/:\s*([\d\s.,]+)\s*€/)?.[1]?.replace(/\s/g, "").replace(",", ".");
            if (!amt || !/^\d{1,8}(\.\d{1,2})?$/.test(amt)) { blockers.push(`${n}: CP bez čitateľnej sumy`); continue; }
            if (price != null && Number(amt) !== price && !CP_AMOUNT_DIFFERS_OK[l.number]) blockers.push(`${n}: suma CP ${amt} ≠ cena ${price}`);
            evs.push({ kind: "CP", at: a.createdAt, userId: a.userId, sources: [a.id], amount: moneyToString(Number(amt)) });
        }
        if (l.quoteSentAt && undoCp.length && !evs.some((e) => e.kind === "CP")) blockers.push(`${n}: quoteSentAt, ale všetky CP zrušené`);
        const used = new Set<string>();
        for (const d of sentDesigns) {
            if (d.deletedAt) { blockers.push(`${n}: poslaný návrh je zmazaný`); continue; }
            const match =
                dsent.find((a) => !used.has(a.id) && Math.abs(a.createdAt.getTime() - d.sentAt!.getTime()) < 2000) ??
                dsent.find((a) => !used.has(a.id) && pairedByMigration.has(`${d.id}|${a.id}`));
            if (!match) { blockers.push(`${n}: poslaný návrh bez DESIGN_SENT`); continue; }
            used.add(match.id);
            // Čas udalosti = pôvodná V1 aktivita (nemenná), nie Design.sentAt, ktorý prevod prepočíta.
            evs.push({ kind: "DESIGN", at: match.createdAt, userId: match.userId, sources: [match.id], design: d });
        }
        if (dsent.length !== used.size) blockers.push(`${n}: DESIGN_SENT bez poslaného návrhu`);
        if (l.designSentAt && !sentDesigns.some((d) => !d.deletedAt)) blockers.push(`${n}: designSentAt bez poslaného návrhu`);
        const hasCp = evs.some((e) => e.kind === "CP");
        if (price != null && !hasCp && !PRICE_WITH_ABOUT_US[l.number] && !PRICE_ONLY_NOT_SENT[l.number]) {
            blockers.push(`${n}: cena ${price} bez CP pri inom odoslaní (nie je v rozhodnutiach)`);
        }
        if (PRICE_WITH_ABOUT_US[l.number] && (price == null || hasCp || !evs.some((e) => e.kind === "ABOUT"))) {
            blockers.push(`${n}: rozhodnutie „cena v úvodnom emaili" už nesedí na dáta`);
        }

        // Zoskupenie podľa obchodného dňa (Q5).
        const byDay = new Map<string, Ev[]>();
        for (const e of evs.sort((a, b) => a.at.getTime() - b.at.getTime())) {
            const day = businessDate(e.at);
            byDay.set(day, [...(byDay.get(day) ?? []), e]);
        }
        let aboutPriceUsed = false;
        for (const [sentOn, group] of byDay) {
            const first = group[0];
            const kinds = new Set(group.map((e) => e.kind));
            const amounts = [...new Set(group.filter((e) => e.amount).map((e) => e.amount!))];
            if (amounts.length > 1) { blockers.push(`${n}: v jeden deň dve rôzne sumy CP`); continue; }
            let amount = amounts[0] ?? null;
            let amountSource: "QUOTE_NOTE" | "DECISION" | undefined = amount ? "QUOTE_NOTE" : undefined;
            if (!amount && PRICE_WITH_ABOUT_US[l.number] && kinds.has("ABOUT") && !aboutPriceUsed && price != null) {
                amount = moneyToString(price);
                amountSource = "DECISION";
                aboutPriceUsed = true;
            }
            const set = new Set<OfferContent>(["ABOUT_US"]);
            if (amount) set.add("PRICE");
            if (kinds.has("DESIGN")) set.add("DESIGN");
            const contents = OFFER_CONTENTS.filter((c) => set.has(c));
            const designs = group.filter((e) => e.design).map((e) => ({ id: e.design!.id, label: e.design!.label, url: e.design!.targetUrl, version: e.design!.currentVersion }));
            const key = `v2mig:offer:${l.id}:${sentOn}`;
            const meta: OfferMeta = {
                channel: "EMAIL",
                contents,
                ...(amount ? { price: { amount, note: price != null && Number(amount) === price ? (l.priceNote ?? null) : null } } : {}),
                ...(designs.length ? { designs } : {}),
                sentOn,
                // Odoslanie so skutočným časom – v2 ho berie ako každé iné (Naposledy, Odoslané, štatistiky). Rozlíšenie
                // „zo starého systému" Michal nechce; meta.migration ostáva len ako neviditeľná proveniencia a kľúč.
                historical: false,
                migrated: true,
                migration: {
                    key,
                    rule: amountSource === "DECISION" ? `${RULE}+decision#${l.number}` : RULE,
                    sources: group.flatMap((e) => e.sources),
                    ...(designs.length ? { designIds: designs.map((d) => d.id) } : {}),
                    originalAt: first.at.toISOString(),
                    ...(amountSource ? { amountSource } : {}),
                    migratedAt,
                },
            };
            if (group.length > 1) notes.push(`${n} ${sentOn}: zlúčené ${group.map((e) => e.kind).join("+")}`);
            events.push({ leadId: l.id, number: l.number, key, sentOn, createdAt: first.at, userId: first.userId, meta });
        }
    }
    return { events, blockers, notes };
}

// Porovnanie plánu s tým, čo už v DB je – kľúč, obsah, suma, návrhy, zdroje (bez migratedAt).
function sameEvent(meta: OfferMeta | null, p: Planned): boolean {
    if (!meta?.migration) return false;
    const norm = (m: OfferMeta) =>
        // Poradie návrhov / zdrojov v jednom emaili nie je významné (po prepočte majú návrhy rovnaký čas) – porovnáva sa množina.
        JSON.stringify([m.channel, m.contents, m.price ?? null, (m.designs ?? []).map((d) => d.id).sort(), m.sentOn, m.migration?.key, [...(m.migration?.sources ?? [])].sort(), m.migration?.amountSource ?? null]);
    return norm(meta) === norm(p.meta);
}

function summarize(events: Planned[]) {
    const by = (pred: (e: Planned) => boolean) => events.filter(pred).length;
    return {
        sends: events.length,
        leads: new Set(events.map((e) => e.leadId)).size,
        infoOnly: by((e) => e.meta.contents.length === 1),
        withPrice: by((e) => e.meta.contents.includes("PRICE")),
        withDesign: by((e) => e.meta.contents.includes("DESIGN")),
        decision: by((e) => e.meta.migration?.amountSource === "DECISION"),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = process.env.DATABASE_URL;
    if (!url) fail("DATABASE_URL chýba (spúšťaj cez tools/with-target.mjs)");
    const host = new URL(url).hostname.split(".")[0];
    if (!args.expectEndpoint || host !== args.expectEndpoint) fail("--expect-endpoint nesedí s cieľom");
    if (host.endsWith("-pooler")) fail("použi DIRECT host");
    if (host.endsWith("m0xyun") && process.env.ZVONCEK_PRODUCTION_WINDOW !== host) fail("produkcia len v schválenom okne (--production-window)");
    if (args.apply && args.confirm !== host) fail("--apply vyžaduje --confirm <endpoint>");
    if (args.apply && args.verify) fail("--apply a --verify naraz nejde");

    const migratedAt = new Date().toISOString();
    const { events, blockers, notes } = await plan(migratedAt);
    console.log(`target=${host} mode=${args.apply ? "APPLY" : args.verify ? "VERIFY" : "DRY-RUN"}`);
    console.log("plan:", summarize(events));
    for (const x of notes) console.log("  merge:", x);
    if (blockers.length) {
        console.log(`BLOCKERS (${blockers.length}) – nič sa nezapíše:`);
        for (const b of blockers) console.log("  ", b);
        process.exit(2);
    }

    const existing = await prisma.activity.findMany({ where: { type: "OFFER_SENT" }, select: { id: true, leadId: true, meta: true } });
    const byKey = new Map<string, OfferMeta | null>();
    let migratedRows = 0;
    for (const a of existing) {
        const meta = parseOfferMeta(a.meta);
        if (meta?.migrated) migratedRows++;
        if (meta?.migration?.key) byKey.set(meta.migration.key, meta);
    }
    const todo = events.filter((e) => !byKey.has(e.key));
    const conflicts = events.filter((e) => byKey.has(e.key) && !sameEvent(byKey.get(e.key)!, e));
    const planned = new Set(events.map((e) => e.key));
    const extra = [...byKey.keys()].filter((k) => k.startsWith("v2mig:offer:") && !planned.has(k));
    console.log(`existing OFFER_SENT=${existing.length} migrated=${migratedRows} · to write=${todo.length} · conflicts=${conflicts.length} · unplanned migrated=${extra.length}`);
    if (conflicts.length || extra.length) {
        for (const c of conflicts) console.log("  CONFLICT", `#${c.number}`, c.sentOn);
        for (const k of extra) console.log("  UNPLANNED", k);
        process.exit(3);
    }

    if (args.verify) {
        // Súhrny obchodu musia zodpovedať prepočtu z platných záznamov (recompute v transakcii, ktorá sa vráti).
        let drift = 0;
        const leadIds = [...new Set(events.map((e) => e.leadId))];
        for (const leadId of leadIds) {
            const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { offerAboutUsAt: true, offerPriceAt: true, designSentAt: true, number: true } });
            try {
                await prisma.$transaction(async (tx) => {
                    await recomputeOffers(tx, leadId);
                    const after = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { offerAboutUsAt: true, offerPriceAt: true, designSentAt: true } });
                    const t = (d: Date | null) => d?.getTime() ?? null;
                    if (t(before.offerAboutUsAt) !== t(after.offerAboutUsAt) || t(before.offerPriceAt) !== t(after.offerPriceAt) || t(before.designSentAt) !== t(after.designSentAt)) {
                        drift++;
                        console.log("  SUMMARY DRIFT", `#${before.number}`);
                    }
                    throw new Error("__rollback__");
                });
            } catch (e) {
                if (!(e instanceof Error && e.message === "__rollback__")) throw e;
            }
        }
        const missing = todo.length;
        console.log(missing || drift ? `\nRESULT: NOT CLEAN (missing=${missing}, summary drift=${drift})` : "\nRESULT: clean");
        process.exit(missing || drift ? 4 : 0);
    }

    if (!args.apply) {
        console.log("\nDRY-RUN – nič nezapísané.");
        return;
    }

    let written = 0;
    const leadIds = [...new Set(todo.map((e) => e.leadId))];
    for (const leadId of leadIds) {
        await withLockTx(async (tx) => {
            if (!(await lockLeadRow(tx, leadId))) throw new Error(`lead ${leadId} zmizol`);
            for (const e of todo.filter((x) => x.leadId === leadId)) {
                const dup = await tx.activity.count({ where: { leadId, type: "OFFER_SENT", meta: { path: ["migration", "key"], equals: e.key } } });
                if (dup) continue;
                await tx.activity.create({
                    data: {
                        leadId,
                        userId: e.userId,
                        type: "OFFER_SENT",
                        category: "BUSINESS",
                        source: "PIPELINE",
                        note: offerNote(e.meta),
                        meta: e.meta,
                        createdAt: e.createdAt,
                    },
                });
                written++;
            }
            await recomputeOffers(tx, leadId); // súhrny + Design.sentAt; revízia +1 raz
        });
    }
    console.log(`\nAPPLIED: ${written} OFFER_SENT na ${leadIds.length} obchodoch. Spusti --verify.`);
}

main()
    .catch((e) => {
        console.error(`ABORT: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
