// Testovací svet pre vývojovú (test) vetvu: VYMAŽE všetky dáta aplikácie a nasadí čerstvé cez skutočné príkazy aplikácie
// (claim, prvý hovor, follow-up, „Čo sme poslali", návrh…), takže platia všetky invarianty (pipelineEnteredAt, revízie,
// história). NIKDY nie produkcia.
//
// Trojitá poistka pred mazaním:
//   1. endpoint v DATABASE_URL = --confirm (a musí končiť na suffix testovacej vetvy),
//   2. endpoint sa LÍŠI od zakomentovanej produkčnej URL v .env (porovnáva sa v pamäti, nič sa nevypisuje),
//   3. databáza má tabuľky/stĺpce, ktoré produkcia nemá (Lead.hadLegacySends + DealRequest alebo DealTask) – produkcia je
//      na starej schéme.
//
//   npx tsx prisma/dummySeeds/seedTestWorld.ts --confirm ep-xxxx            # vymaže + nasadí celý svet
//   npx tsx prisma/dummySeeds/seedTestWorld.ts --confirm ep-xxxx --minimal  # vymaže + len účty a ~50 kontaktov od skauta
//                                                                           # (wave 3 §10 krok 0: žiadne hovory ani obchody)
// Všetky účty majú heslo password123.
import "dotenv/config";
import { readFileSync } from "node:fs";
import bcrypt from "bcrypt";
import { Client } from "pg";
import type { Role } from "../../app/generated/prisma/enums";
import prisma from "../../lib/db";
import type { AccessUser } from "../../lib/access/user";
import { claimBatchAs } from "../../lib/commands/claims";
import { logCallAs } from "../../lib/commands/calls";
import { logFollowUpAs } from "../../lib/commands/dealWork";
import { saveDealQuoteAs } from "../../lib/commands/dealWork";
import { changeStatusAs, saveQuoteAs } from "../../lib/commands/pipeline";
import { recordOfferSentAs } from "../../lib/commands/offers";
import { createDesignAs } from "../../lib/commands/tracking";
import { businessDate } from "../../lib/domain/businessTime";
import type { FirstCallOutcome } from "../../lib/domain/leadFlow";

const TEST_SUFFIX = "nhww8x";
// Mažú sa všetky tabuľky aplikácie, ktoré v schéme existujú (pred aj po wave 3).
const TABLES = [
    "TrackerEvent",
    "Tracker",
    "DesignVersion",
    "Design",
    "DealRequest",
    "LeadRequest",
    "DealTaskPart",
    "DealTask",
    "DealOwnership",
    "Activity",
    "Lead",
    "Invite",
    "Team",
    "User",
];
const MINIMAL = process.argv.includes("--minimal");

function fail(message: string): never {
    console.error(`ABORT: ${message}`);
    process.exit(1);
}
const endpointOf = (u: string) => new URL(u).hostname.split(".")[0].replace(/-pooler$/, "");

async function guard() {
    const confirm = process.argv[process.argv.indexOf("--confirm") + 1];
    const current = process.env.DATABASE_URL;
    if (!current) fail("DATABASE_URL nie je nastavené.");
    const ep = endpointOf(current);
    if (!process.argv.includes("--confirm") || confirm !== ep) fail("--confirm <endpoint> musí sedieť s DATABASE_URL.");
    if (!ep.endsWith(TEST_SUFFIX)) fail(`endpoint nekončí na testovací suffix …${TEST_SUFFIX}.`);
    // 2. produkčná URL je v .env zakomentovaná – nesmie to byť tá istá
    const commented = readFileSync(".env", "utf8")
        .split(/\r?\n/)
        .filter((l) => /^\s*#\s*DATABASE_URL\s*=/.test(l))
        .map((l) => l.replace(/^\s*#\s*DATABASE_URL\s*=\s*/, "").replace(/^["']|["']$/g, ""));
    if (commented.length === 0) fail("v .env chýba zakomentovaná produkčná DATABASE_URL na porovnanie.");
    for (const url of commented) {
        try {
            if (endpointOf(url) === ep) fail("DATABASE_URL = produkčný endpoint!");
        } catch {
            fail("zakomentovanú URL v .env sa nepodarilo prečítať – radšej nič.");
        }
    }
    // 3. odtlačok schémy, ktorý produkcia nemá
    const c = new Client({ connectionString: current });
    await c.connect();
    const r = await c.query<{ ok: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name IN ('DealRequest', 'DealTask'))
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Lead' AND column_name = 'hadLegacySends') AS ok`);
    if (!r.rows[0]?.ok) {
        await c.end();
        fail("schéma nevyzerá ako testovacia vetva (chýba DealRequest/DealTask / Lead.hadLegacySends).");
    }
    console.log(`identity OK: endpoint=…${ep.slice(-6)} (≠ produkcia), schéma testovacej vetvy`);
    return c;
}

type U = AccessUser;
const key = () => crypto.randomUUID();
const rev = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id }, select: { revision: true } })).revision;
function ok(label: string, r: unknown) {
    if (r && typeof r === "object" && "error" in r) throw new Error(`${label}: ${(r as { error: string }).error}`);
}

async function main() {
    const c = await guard();
    const present = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [TABLES],
    );
    const names = TABLES.filter((t) => present.rows.some((r) => r.table_name === t));
    await c.query(`TRUNCATE ${names.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await c.end();
    console.log(`vymazané: ${names.join(", ")}`);
    if (MINIMAL) return seedMinimal();

    const password = await bcrypt.hash("password123", 10);
    const mk = async (username: string, firstName: string, lastName: string, role: Role, extra: { teamId?: string; deletedAt?: Date } = {}) =>
        prisma.user.create({
            data: { username, firstName, lastName, role, password, ...extra },
            select: { id: true, role: true, teamId: true, firstName: true, lastName: true, username: true },
        });

    // ── Ľudia a tímy: obe usporiadania – telesales → manažér (Obchod) aj telesales → obchodník (Tím Jana) ──
    const michal = await mk("t_michal", "Michal", "Chovanec", "ADMIN");
    await mk("t_nikolas", "Nikolas", "Manažér", "MANAGER");
    const jana = await mk("t_rep", "Jana", "Obchodníková", "SALES_REP");
    const sales = await mk("sales", "Samo", "Predaj", "SALES_REP");
    const simon = await mk("t_simon", "Šimon", "Vedúci", "SCOUT_LEADER");
    const obchod = await prisma.team.create({ data: { name: "Obchod", leaderId: michal.id } });
    const timJana = await prisma.team.create({ data: { name: "Tím Jana", leaderId: jana.id } });
    const skauti = await prisma.team.create({ data: { name: "Skauti", leaderId: simon.id } });
    const timea = await mk("t_timea", "Timea", "Volajúca", "TELESALES", { teamId: obchod.id });
    const tereza = await mk("t_tereza", "Tereza", "Volajúca", "TELESALES", { teamId: timJana.id });
    await mk("t_odisla", "Oľga", "Odišla", "TELESALES", { deletedAt: new Date() });
    const jano = await mk("t_jano", "Jano", "Skaut", "SCOUT", { teamId: skauti.id });
    await mk("t_lukas", "Lukáš", "Skaut", "SCOUT", { teamId: skauti.id });
    await prisma.user.update({ where: { id: simon.id }, data: { teamId: skauti.id } });

    // ── Kontakty v spoločnej fronte (pridal skaut), staršie = claim ich berie prvé ──
    const firms = [
        "Pekáreň Kvások", "Autoservis Vlk", "Zubná ambulancia Breza", "Penzión Mráz", "Kaderníctvo Luna", "Stolárstvo Dub",
        "Fitness Sila", "Kvetinárstvo Ruža", "Právna kancelária Lexa", "Veterina Sokol", "Pizzeria Nagy", "Reštaurácia Gazdovský dvor",
        "Elektro Blesk", "Cukráreň Sladkosť", "Stavebniny Kameň", "Optika Jasný zrak", "Kozmetika Aura", "Hotel Tatry", "Pneuservis Guma",
        "Vinárstvo Réva", "Detský kútik Hopsa", "Tlačiareň Farba", "Fotoateliér Blesk", "Klampiarstvo Plech", "Masáže Relax",
        "Čistiareň Snehulienka", "Kaviareň Zrnko", "Pohreb. služba Pokoj", "Jazdiareň Podkova", "Krajčírstvo Ihla",
        "Sklenárstvo Číre", "Autoškola Volant", "Záhradníctvo Zeleň", "Mäsiarstvo Šunka", "Hudobná škola Tón", "Keramika Hlina",
        "Pivovar Chmeľ", "Taxi Rýchlik", "Upratovanie Lesk", "Zámočníctvo Kľúč", "Úctáreň Mestská", "Priadza a gombíky",
        "Bicykle Pedál", "Rámovanie Obraz", "Solárium Slnko", "Psí salón Fúzik", "Pedikúra Krok", "Požičovňa Lodička",
    ];
    const now = Date.now();
    for (let i = 0; i < firms.length; i++) {
        await prisma.lead.create({
            data: {
                companyName: firms[i],
                phone: `+421 9${String(10 + i).padStart(2, "0")} ${String(100000 + i * 7919).slice(0, 3)} ${String(100 + i).slice(-3)}`,
                website: `${firms[i].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, "")}.sk`,
                note: i % 5 === 0 ? "stránka im občas nejde" : null,
                createdById: jano.id,
                createdAt: new Date(now - (firms.length - i) * 3_600_000),
            },
        });
    }
    console.log(`kontakty: ${firms.length}`);

    // ── Prvé hovory cez skutočný claim + logCall ──
    async function callBatch(u: U, outcomes: (FirstCallOutcome | null)[]) {
        ok(`claim ${u.username}`, await claimBatchAs(u));
        const batch = await prisma.lead.findMany({ where: { assignedCallerId: u.id, status: "NEW" }, orderBy: { createdAt: "asc" }, select: { id: true } });
        const deals: string[] = [];
        for (let i = 0; i < outcomes.length && i < batch.length; i++) {
            const outcome = outcomes[i];
            if (!outcome) continue;
            const id = batch[i].id;
            const schedule =
                outcome === "CALL_AGAIN" ? { kind: "daysFromToday" as const, days: 1 } : outcome === "SNOOZE" ? { kind: "monthsFromToday" as const, months: 2 } : undefined;
            ok(`call ${u.username}`, await logCallAs(u, { leadId: id, outcome, expectedRevision: await rev(id), idempotencyKey: key(), ...(schedule ? { schedule } : {}) }));
            if (outcome === "WANTS_QUOTE" || outcome === "WANTS_EMAIL" || outcome === "WANTS_DESIGN") deals.push(id);
        }
        return deals;
    }
    // Timea (tím Obchod) → obchody idú Michalovi; Tereza (Tím Jana) → Jane; obchodníci volajú sami pre seba.
    // „Chcú návrh" zámerne nie – dnešný kód by pri ňom automaticky založil požiadavku (wave 3 to mení).
    const mDeals = await callBatch(timea, ["WANTS_QUOTE", "WANTS_EMAIL", "NO_ANSWER", "CALL_AGAIN", "NOT_INTERESTED", "WANTS_EMAIL", "BAD_NUMBER", "NO_ANSWER"]);
    const jDeals = await callBatch(tereza, ["WANTS_EMAIL", "WANTS_QUOTE", "NO_ANSWER", "WANTS_EMAIL", "SNOOZE", "WANTS_QUOTE"]);
    const jOwn = await callBatch(jana, ["WANTS_EMAIL", "NO_ANSWER", "WANTS_QUOTE"]);
    const sDeals = await callBatch(sales, ["WANTS_EMAIL", "WANTS_QUOTE", "NO_ANSWER", "WANTS_EMAIL"]);
    console.log(`obchody: Michal ${mDeals.length}, Jana ${jDeals.length + jOwn.length}, Samo ${sDeals.length}`);

    const today = businessDate(new Date());
    const send = async (u: U, id: string, contents: ("ABOUT_US" | "PRICELIST" | "PRICE" | "DESIGN")[], extra: { designIds?: string[] } = {}) =>
        ok("send", await recordOfferSentAs(u, { leadId: id, expectedRevision: await rev(id), idempotencyKey: key(), contents, sentOn: today, followUp: true, ...extra }));
    const follow = async (u: U, id: string, input: Record<string, unknown>) =>
        ok("follow", await logFollowUpAs(u, { leadId: id, expectedRevision: await rev(id), idempotencyKey: key(), outcome: "POSITIVE", ...input } as Parameters<typeof logFollowUpAs>[1]));

    // ── Rôzne štádiá obchodov ──
    const [j1, j2, j3, j4, j5] = [...jDeals, ...jOwn];
    await send(jana, j1, ["ABOUT_US", "PRICELIST"]); // úvodný email odišiel, čaká sa
    ok("price", await saveDealQuoteAs(jana, j2, { price: 1290, priceNote: "Web 790 € · admin 300 € · SEO 200 €" }));
    await send(jana, j2, ["ABOUT_US", "PRICE"]); // poslaná konkrétna cena
    await follow(jana, j3, { outcome: "NO_ANSWER" });
    await follow(jana, j3, { outcome: "NO_ANSWER" }); // „2. pokus"
    ok("design", await createDesignAs(michal, { leadId: j4, label: "smrek1", url: "smrek1.thegrandpoints.com" }));
    const design = await prisma.design.findFirstOrThrow({ where: { leadId: j4 } });
    await send(jana, j4, ["ABOUT_US", "PRICELIST", "DESIGN"], { designIds: [design.id] }); // návrh poslaný
    await follow(jana, j4, { reply: "NOT_LOOKED_YET", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 } });
    if (j5) await follow(jana, j5, { contact: "SMS", note: "web + kontakt", nextKind: "WAITING_FOR_CLIENT" });

    const [m1, m2, m3] = mDeals;
    ok("price", await saveQuoteAs(michal, m1, { price: 890, priceNote: "Web 690 € · jazyk 200 €" }));
    await send(michal, m1, ["PRICE"]);
    await follow(michal, m2, { reply: "DECIDING", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 7 } });
    if (m3) ok("won", await changeStatusAs(michal, m3, { status: "WON", expectedRevision: await rev(m3), idempotencyKey: key() }));

    const [s1, s2] = sDeals;
    await send(sales, s1, ["ABOUT_US", "PRICELIST"]);
    if (s2) await follow(sales, s2, { outcome: "NOT_INTERESTED", lostReason: "majú dodávateľa" });

    // Jeden obchod po termíne (starší plán), aby „Na dnes" nebolo prázdne a urgentnosť bolo vidno.
    await prisma.lead.update({ where: { id: j1 }, data: { nextActionAt: new Date(Date.now() - 2 * 86_400_000) } });

    const counts = await prisma.lead.groupBy({ by: ["status"], _count: true });
    console.log("stavy:", counts.map((x) => `${x.status} ${x._count}`).join(", "));
    console.log("\nÚčty (heslo password123): t_michal (ADMIN, vedie Obchod), t_nikolas (MANAGER), t_rep = Jana (SALES_REP, vedie Tím Jana),");
    console.log("sales = Samo (SALES_REP), t_timea (TELESALES → Michal), t_tereza (TELESALES → Jana), t_odisla (deaktivovaná),");
    console.log("t_simon (SCOUT_LEADER), t_jano, t_lukas (SCOUT).");
}

// Wave 3 §10 krok 0: len účty, tímy a kontakty od skauta (NEW, nikto ich nemá, žiadne hovory, obchody ani odoslania).
async function seedMinimal() {
    const password = await bcrypt.hash("password123", 10);
    const mk = (username: string, firstName: string, lastName: string, role: Role, teamId?: string) =>
        prisma.user.create({ data: { username, firstName, lastName, role, password, ...(teamId ? { teamId } : {}) }, select: { id: true } });
    const admin = await mk("admin", "Adam", "Admin", "ADMIN");
    const sales = await mk("sales", "Sam", "Sales", "SALES_REP");
    const manager = await mk("manager", "Marek", "Manager", "MANAGER");
    const scoutleader = await mk("scoutleader", "Sven", "Scoutleader", "SCOUT_LEADER");
    const obchod = await prisma.team.create({ data: { name: "Obchod", leaderId: manager.id } });
    // Obchodníčka je v tíme Obchod → jej predvolený manažér pri úlohách je vedúci tímu (Nikolas).
    await prisma.user.update({ where: { id: sales.id }, data: { teamId: obchod.id } });
    const skauti = await prisma.team.create({ data: { name: "Skauti", leaderId: scoutleader.id } });
    await prisma.user.update({ where: { id: scoutleader.id }, data: { teamId: skauti.id } });
    await mk("telesales", "Tina", "Telesales", "TELESALES", obchod.id);
    const scout = await mk("scout", "Sára", "Scout", "SCOUT", skauti.id);
    void admin;

    const now = Date.now();
    const total = 50;
    for (let i = 0; i < total; i++) {
        const name = `${FIRM_PREFIX[i % FIRM_PREFIX.length]} ${FIRM_SUFFIX[Math.floor(i / FIRM_PREFIX.length) % FIRM_SUFFIX.length]}`;
        await prisma.lead.create({
            data: {
                companyName: name,
                phone: `+421 9${String(10 + i).padStart(2, "0")} ${String(100000 + i * 7919).slice(0, 3)} ${String(100 + i).slice(-3)}`,
                website: `${name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, "")}.sk`,
                note: i % 5 === 0 ? "stránka im občas nejde" : i % 7 === 0 ? "čítal som o nich v novinách" : null,
                createdById: scout.id,
                createdAt: new Date(now - (total - i) * 3_600_000),
            },
        });
    }
    const counts = {
        users: await prisma.user.count(),
        teams: await prisma.team.count(),
        leads: await prisma.lead.count(),
        newUnclaimed: await prisma.lead.count({ where: { status: "NEW", assignedCallerId: null, pipelineEnteredAt: null, createdById: scout.id } }),
        activities: await prisma.activity.count(),
    };
    console.log("minimálny svet:", JSON.stringify(counts));
    console.log("\nÚčty (heslo password123): admin (ADMIN), sales (SALES_REP, člen Obchod), manager (MANAGER, vedie Obchod),");
    console.log("telesales (TELESALES, člen Obchod → pozitívne hovory idú manažérovi), scout (SCOUT, člen Skauti), scoutleader (SCOUT_LEADER, vedie Skauti).");
}

const FIRM_PREFIX = [
    "Pekáreň", "Autoservis", "Kaderníctvo", "Stolárstvo", "Kvetinárstvo", "Veterina", "Pizzeria", "Cukráreň", "Optika", "Penzión",
];
const FIRM_SUFFIX = ["Kvások", "Breza", "Luna", "Dub", "Sokol"];

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
