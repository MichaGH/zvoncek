// Feature 02 – vykreslené stránky (R02-02, R02-03, R02-06, R02-07, R02-04, R02-14). Potrebuje bežiaci `next dev` nad
// dev kópiou. Vlastní používatelia + fixture kontakty, podpísané lokálne relácie pre TÝCHTO používateľov (nikdy pre
// skutočný účet), na konci sa všetko zmaže.
//   npx tsx prisma/backfill/check-recycling-http.ts --expect-endpoint ep-divine-waterfall-asbkuort --base http://localhost:3100
import "dotenv/config";
import { encode } from "next-auth/jwt";
import type { Role } from "../../app/generated/prisma/enums";
import prisma from "../../lib/db";
import { logCallAs } from "../../lib/commands/calls";
import { recycleLeadsAs } from "../../lib/commands/recycling";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const base = arg("--base") ?? "http://localhost:3100";
const ep = new URL(process.env.DATABASE_URL ?? "postgres://x/none").hostname.split(".")[0].replace(/-pooler$/, "");
if (ep !== "ep-divine-waterfall-asbkuort" || arg("--expect-endpoint") !== ep) {
    console.error("ABORT: development endpoint required (--expect-endpoint must match DATABASE_URL).");
    process.exit(1);
}

const RUN = Date.now().toString(36);
const users: string[] = [];
const leads: string[] = [];
let ok = 0;
let bad = 0;
function check(name: string, pass: boolean, detail = "") {
    if (pass) ok++;
    else bad++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` – ${detail}` : ""}`);
}

type U = { id: string; role: Role; username: string; firstName: string; lastName: string; teamId: string | null };
async function mk(role: Role): Promise<U> {
    const u = await prisma.user.create({
        data: { username: `ht_${RUN}_${users.length}`.slice(0, 20), firstName: "HT", lastName: role, password: "!", role },
        select: { id: true, role: true, username: true, firstName: true, lastName: true, teamId: true },
    });
    users.push(u.id);
    return u;
}
async function get(u: U, path: string) {
    const token = await encode({
        token: { sub: u.id, id: u.id, role: u.role, username: u.username, firstName: u.firstName, lastName: u.lastName, name: u.username },
        secret: process.env.AUTH_SECRET!,
        salt: "authjs.session-token",
    });
    const res = await fetch(`${base}${path}`, { headers: { cookie: `authjs.session-token=${token}` }, redirect: "manual" });
    const raw = res.status === 200 ? await res.text() : "";
    const text = raw.replace(/<!-- -->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
    return { status: res.status, raw, text };
}

async function main() {
    const admin = await mk("ADMIN");
    const scout = await mk("SCOUT");
    const caller = await mk("TELESALES");
    const tag = `HT-${RUN}`;
    // a: scout ho pridal, nemajú záujem, recyklovaný → vo fronte, 2. kolo. b: nezdvihli s poznámkou „nevolať".
    const make = async (name: string, note: string | null) => {
        const l = await prisma.lead.create({
            data: { companyName: `${tag} ${name}`, phone: `+000 ${RUN} ${name}`, note, createdById: scout.id, assignedCallerId: caller.id, assignedCallerAt: new Date() },
            select: { id: true, revision: true },
        });
        leads.push(l.id);
        return l;
    };
    const a = await make("a", null);
    const b = await make("b", "Pán povedal: nevolať!");
    await logCallAs(caller, { leadId: a.id, outcome: "NOT_INTERESTED", expectedRevision: a.revision, idempotencyKey: crypto.randomUUID() });
    await logCallAs(caller, { leadId: b.id, outcome: "NO_ANSWER", expectedRevision: b.revision, idempotencyKey: crypto.randomUUID() });
    const aRev = (await prisma.lead.findUniqueOrThrow({ where: { id: a.id }, select: { revision: true } })).revision;
    const r = await recycleLeadsAs(admin, { items: [{ leadId: a.id, expectedRevision: aRev }] });
    check("setup: fixture recycled", !("error" in r) && r.recycled === 1, JSON.stringify(r));

    // R02-02 + R02-07: admin môže recyklovaný kontakt upraviť; scout, ktorý ho pridal, vidí zámok „recyklovaný".
    const q = encodeURIComponent(`${tag} a`);
    const asAdmin = await get(admin, `/dashboard/contacts?view=pool&q=${q}`);
    const asScout = await get(scout, `/dashboard/contacts?view=pool&q=${q}`);
    check("R02-02: admin sees the edit action on a recycled contact in the pool",
        asAdmin.text.includes(`${tag} a`) && asAdmin.raw.includes('aria-label="Upraviť kontakt"') && !asAdmin.text.includes("recyklovaný"));
    check("R02-02 / R02-07: the scout who added it sees it locked as 'recyklovaný', not 'obvolaný'",
        asScout.text.includes(`${tag} a`) && asScout.text.includes("recyklovaný") && !asScout.text.includes("obvolaný") &&
            !asScout.raw.includes('aria-label="Upraviť kontakt"'));

    // R02-03: zobrazené poradie = poradie v celej fronte, aj s hľadaním.
    const rank = (await prisma.$queryRaw<{ rank: number }[]>`
        SELECT q.rank::int AS rank FROM (SELECT id, row_number() OVER (ORDER BY COALESCE("roundStartedAt", "createdAt"), id) AS rank
          FROM "Lead" WHERE "deletedAt" IS NULL AND status = 'NEW' AND "pipelineEnteredAt" IS NULL AND "assignedCallerId" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "Activity" x WHERE x."leadId" = "Lead".id AND x.type = 'CALL')) q WHERE q.id = ${a.id}`)[0]?.rank;
    check("R02-03: a filtered Na volanie row shows its rank in the whole queue", rank !== undefined && rank > 1 && asAdmin.text.includes(`${rank}. v poradí`),
        `rank=${rank}`);

    // R02-06: odkaz z hlavičky nesie len rozsah, a číslo v hlavičke = číslo na prepínači po kliknutí.
    const filtered = await get(admin, `/dashboard/contacts?round=2&q=${q}`);
    const href = filtered.raw.match(/href="(\/dashboard\/contacts\?view=pool[^"]*)"[^>]*>\s*(?:<!-- -->)?\s*(\d+)(?:<!-- -->)? voľných na volanie/);
    const target = href ? await get(admin, href[1].replace(/&amp;/g, "&")) : null;
    const switchCount = target?.text.match(/Na volanie (\d+)/)?.[1];
    check("R02-06: header link carries no round / search, and its number equals the Na volanie count it opens",
        Boolean(href) && href![1] === "/dashboard/contacts?view=pool" && switchCount === href![2], `href=${href?.[1]} header=${href?.[2]} switch=${switchCount}`);

    // R02-04: recyklačný panel skryje „nevolať", ukáže koľko je skrytých, poznámku a varovný znak pri zobrazení.
    const panelQ = encodeURIComponent(tag);
    const hidden = await get(admin, `/dashboard/admin/recycle?b=call_retry&older=0&q=${panelQ}`);
    const shown = await get(admin, `/dashboard/admin/recycle?b=call_retry&older=0&dnc=show&q=${panelQ}`);
    check("R02-04: panel hides the 'nevolať' contact by default and says how many are hidden",
        hidden.text.includes("Nájdené: 0") && /Skryté – v poznámke „nevolať[“"]: 1/.test(hidden.text), hidden.text.match(/Skryté[^.]{0,60}/)?.[0] ?? "");
    check("R02-04: with dnc=show the contact, its note and the warning mark are shown",
        shown.text.includes("Nájdené: 1") && shown.text.includes("Pán povedal: nevolať!") && shown.raw.includes('aria-label="nevolať"'));
    // R02-14: na jedinej strane sú stránkovacie tlačidlá nevykreslené; „Vybrať prvých" je vypnuté pri 0 výsledkoch.
    check("R02-14: no pagination links on a single page", !hidden.raw.includes('aria-label="Predchádzajúca strana"'));
}

main()
    .catch((e) => {
        bad++;
        console.error(e);
    })
    .finally(async () => {
        const archives = (await prisma.lead.findMany({ where: { archiveOfId: { in: leads } }, select: { id: true } })).map((x) => x.id);
        const all = [...archives, ...leads];
        await prisma.leadRequest.deleteMany({ where: { leadId: { in: all } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: all } } });
        await prisma.lead.deleteMany({ where: { id: { in: archives } } });
        await prisma.lead.deleteMany({ where: { id: { in: leads } } });
        await prisma.activity.deleteMany({ where: { userId: { in: users } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        await prisma.$disconnect();
        console.log(`\ncleanup complete; ${ok}/${ok + bad} passed; failures=${bad}`);
        if (bad) process.exitCode = 1;
    });
