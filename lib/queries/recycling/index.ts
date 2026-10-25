import { Prisma } from "@/app/generated/prisma/client";
import type { CallOutcome, LeadStatus, RequestContent } from "@/app/generated/prisma/enums";
import prisma from "@/lib/db";
import {
    DO_NOT_CALL_PATTERN,
    RECYCLE_BUCKETS,
    RECYCLE_HOLDER_NONE,
    RECYCLE_MAX_ITEMS,
    RECYCLE_PAGE_SIZE,
    type RecycleBucket,
    type RecycleParams,
} from "@/lib/domain/recycling";
import { getPoolCount } from "@/lib/queries/calls";

// Panel recyklácie (spec §5, §8). Zoznam, počty košov aj „vybrať prvých N" čítajú JEDEN predikát (eligibleCte),
// takže číslo na pilulke sa rovná tomu, čo ukáže klik.

// SQL dvojča recycleBucketOf() z lib/domain/recycling.ts – paritný test rc9Parity v check-concurrency.ts.
export const RECYCLE_BUCKET_SQL = Prisma.sql`(CASE
    WHEN l."pipelineEnteredAt" IS NULL AND l.status = 'CALLING' AND l."callbackKind" = 'RETRY' THEN 'call_retry'
    WHEN l."pipelineEnteredAt" IS NULL AND l.status = 'CALLING' AND l."callbackKind" = 'SCHEDULED' THEN 'call_scheduled'
    WHEN l."pipelineEnteredAt" IS NULL AND l.status = 'SNOOZED' THEN 'call_snoozed'
    WHEN l."pipelineEnteredAt" IS NULL AND l.status = 'LOST' THEN 'call_lost'
    WHEN l."pipelineEnteredAt" IS NULL AND l.status = 'UNREACHABLE' THEN 'call_unreachable'
    WHEN l."pipelineEnteredAt" IS NOT NULL AND l.status = 'ACTIVE' THEN 'deal_active'
    WHEN l."pipelineEnteredAt" IS NOT NULL AND l.status = 'SNOOZED' THEN 'deal_snoozed'
    WHEN l."pipelineEnteredAt" IS NOT NULL AND l.status = 'LOST' THEN 'deal_lost'
    WHEN l."pipelineEnteredAt" IS NOT NULL AND l.status = 'UNREACHABLE' THEN 'deal_unreachable'
END)`;

// SQL dvojča recycleBlocker() == null.
export const RECYCLE_ELIGIBLE_SQL = Prisma.sql`(
    l."deletedAt" IS NULL AND l."archiveOfId" IS NULL AND ${RECYCLE_BUCKET_SQL} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "DealTask" t WHERE t."leadId" = l.id AND t.status = 'OPEN')
)`;

// Posledný skutočný kontakt (hovor, odpoveď, SMS, čo sme poslali); bez neho dátum pridania.
const LAST_CONTACT_SQL = Prisma.sql`COALESCE((
    SELECT max(a."createdAt") FROM "Activity" a
     WHERE a."leadId" = l.id AND a."revertedAt" IS NULL AND a.type IN ('CALL', 'CLIENT_REPLIED', 'SMS_SENT', 'OFFER_SENT')
), l."createdAt")`;

const TRIES_SQL = Prisma.sql`(
    SELECT count(*)::int FROM "Activity" a
     WHERE a."leadId" = l.id AND a.type = 'CALL' AND a.outcome = 'NO_ANSWER' AND a."revertedAt" IS NULL
)`;

const GOT_SQL: Record<NonNullable<RecycleParams["got"]>, Prisma.Sql> = {
    info: Prisma.sql`l."offerAboutUsAt" IS NOT NULL`,
    pricelist: Prisma.sql`l."offerPricelistAt" IS NOT NULL`,
    price: Prisma.sql`l."offerPriceAt" IS NOT NULL`,
    design: Prisma.sql`l."designSentAt" IS NOT NULL`,
};

// Filtre na samotnom riadku Lead (všetko okrem koša a držiteľa).
function leadFilter(p: RecycleParams): Prisma.Sql {
    const parts: Prisma.Sql[] = [RECYCLE_ELIGIBLE_SQL];
    if (p.got) parts.push(GOT_SQL[p.got]);
    if (p.asked) parts.push(Prisma.sql`l."pipelineEnteredAt" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "LeadRequest" r WHERE r."leadId" = l.id AND r.state = 'OPEN' AND r.content::text = ${p.asked}
    )`);
    if (p.round === "1") parts.push(Prisma.sql`l.round = 1`);
    if (p.round === "2") parts.push(Prisma.sql`l.round >= 2`);
    if (p.q) {
        const like = `%${p.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const num = /^#?\d{1,9}$/.test(p.q) ? Number(p.q.replace("#", "")) : null;
        // R02-04: hľadá aj v poznámke a dôvode straty – „nevolať", „konkurencia"… sa dá nájsť a vynechať.
        parts.push(Prisma.sql`(l."companyName" ILIKE ${like} OR l.website ILIKE ${like} OR l.phone ILIKE ${like}
            OR l.email ILIKE ${like} OR l.note ILIKE ${like} OR l."lostReason" ILIKE ${like}${num !== null ? Prisma.sql` OR l.number = ${num}` : Prisma.empty})`);
    }
    return Prisma.join(parts, " AND ");
}

// „Kto to mal": obchod = vlastník; fáza volania = priradený volajúci, a keďže „Nemajú záujem" / „Zlé číslo"
// priradenie mažú, inak autor posledného hovoru (inak by filter „timea" nenašiel jej uzavreté kontakty).
const HOLDER_SQL = Prisma.sql`(CASE WHEN l."pipelineEnteredAt" IS NULL THEN COALESCE(l."assignedCallerId", (
    SELECT a."userId" FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'CALL' AND a."revertedAt" IS NULL
     ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
)) ELSE l."ownerId" END)`;

// SQL dvojča isDoNotCall() (R02-04): poznámka kontaktu alebo dôvod straty obsahuje „nevolať" & spol.
export const DO_NOT_CALL_SQL = Prisma.sql`(COALESCE(l.note, '') ~* ${DO_NOT_CALL_PATTERN} OR COALESCE(l."lostReason", '') ~* ${DO_NOT_CALL_PATTERN})`;

// Jeden riadok na kandidáta: kôš, posledný kontakt, počet „nezdvihli", kto ho mal, „nevolať".
function eligibleCte(p: RecycleParams): Prisma.Sql {
    return Prisma.sql`WITH c AS (
        SELECT l.id, ${RECYCLE_BUCKET_SQL} AS bucket, ${LAST_CONTACT_SQL} AS last_at, ${TRIES_SQL} AS tries,
               ${HOLDER_SQL} AS holder, ${DO_NOT_CALL_SQL} AS dnc
          FROM "Lead" l
         WHERE ${leadFilter(p)}
    )`;
}

// Filtre nad CTE; `without` vynechá jeden (počty košov ignorujú výber košov, ponuka držiteľov ignoruje držiteľa).
function outerFilter(p: RecycleParams, without?: "buckets" | "holder"): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (without !== "buckets") {
        parts.push(p.buckets.length ? Prisma.sql`c.bucket = ANY(${p.buckets})` : Prisma.sql`FALSE`);
    }
    if (without !== "holder" && p.holder) {
        parts.push(p.holder === RECYCLE_HOLDER_NONE ? Prisma.sql`c.holder IS NULL` : Prisma.sql`c.holder = ${p.holder}`);
    }
    if (p.older > 0) parts.push(Prisma.sql`c.last_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${p.older})`);
    if (p.tries > 0) parts.push(Prisma.sql`c.tries >= ${p.tries}`);
    if (p.dnc === "hide") parts.push(Prisma.sql`NOT c.dnc`);
    return Prisma.join(parts, " AND ");
}

const ORDER_SQL: Record<RecycleParams["sort"], Prisma.Sql> = {
    last_asc: Prisma.sql`c.last_at ASC, c.id`,
    last_desc: Prisma.sql`c.last_at DESC, c.id`,
    added_asc: Prisma.sql`l."createdAt" ASC, c.id`,
    added_desc: Prisma.sql`l."createdAt" DESC, c.id`,
    number: Prisma.sql`l.number ASC`,
};

const OPEN_ASKS_SQL = Prisma.sql`(SELECT array_agg(DISTINCT r.content::text) FROM "LeadRequest" r
    WHERE r."leadId" = l.id AND r.state = 'OPEN')`;

// Mená držiteľov + či sú aktívni (R02-05: varovanie, keď recyklácia berie prácu aktívnemu volajúcemu).
async function holderNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const users = unique.length
        ? await prisma.user.findMany({
              where: { id: { in: unique } },
              select: { id: true, firstName: true, lastName: true, deletedAt: true },
          })
        : [];
    return new Map(users.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`.trim(), active: u.deletedAt === null }]));
}

type RowRaw = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    email: string | null;
    status: LeadStatus;
    isDeal: boolean;
    revision: number;
    round: number;
    lostReason: string | null;
    bucket: RecycleBucket;
    last_at: Date;
    tries: number;
    holder: string | null;
    dnc: boolean;
    note: string | null;
    lastOutcome: CallOutcome | null;
    gotInfo: boolean;
    gotPrice: boolean;
    gotDesign: boolean;
    openAsks: RequestContent[] | null;
};

export async function getRecycleList(p: RecycleParams) {
    const offset = (p.page - 1) * RECYCLE_PAGE_SIZE;
    const [rows, totalRows] = await Promise.all([
        prisma.$queryRaw<RowRaw[]>`${eligibleCte(p)}
            SELECT c.id, l.number, l."companyName", l.website, l.phone, l.email, l.status,
                   (l."pipelineEnteredAt" IS NOT NULL) AS "isDeal", l.revision, l.round, l."lostReason",
                   c.bucket, c.last_at, c.tries, c.holder, c.dnc, l.note,
                   (SELECT a.outcome FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'CALL' AND a."revertedAt" IS NULL
                     ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1) AS "lastOutcome",
                   (l."offerAboutUsAt" IS NOT NULL OR l."offerPricelistAt" IS NOT NULL) AS "gotInfo",
                   (l."offerPriceAt" IS NOT NULL) AS "gotPrice",
                   (l."designSentAt" IS NOT NULL) AS "gotDesign",
                   ${OPEN_ASKS_SQL} AS "openAsks"
              FROM c JOIN "Lead" l ON l.id = c.id
             WHERE ${outerFilter(p)}
             ORDER BY ${ORDER_SQL[p.sort]}
             LIMIT ${RECYCLE_PAGE_SIZE} OFFSET ${offset}`,
        prisma.$queryRaw<{ n: number }[]>`${eligibleCte(p)} SELECT count(*)::int AS n FROM c WHERE ${outerFilter(p)}`,
    ]);

    const name = await holderNames(rows.map((r) => r.holder));

    return {
        total: totalRows[0]?.n ?? 0,
        rows: rows.map((r) => ({
            id: r.id,
            number: r.number,
            companyName: r.companyName,
            website: r.website,
            phone: r.phone,
            email: r.email,
            status: r.status,
            isDeal: r.isDeal,
            revision: r.revision,
            round: r.round,
            lostReason: r.lostReason,
            bucket: r.bucket,
            lastAt: r.last_at.toISOString(),
            tries: r.tries,
            holderId: r.holder,
            holderName: r.holder ? (name.get(r.holder)?.name ?? "—") : null,
            holderActive: r.holder ? (name.get(r.holder)?.active ?? false) : false,
            note: r.note,
            doNotCall: r.dnc,
            lastOutcome: r.lastOutcome,
            got: { info: r.gotInfo, price: r.gotPrice, design: r.gotDesign },
            openAsks: r.openAsks ?? [],
        })),
    };
}

export type RecycleRow = Awaited<ReturnType<typeof getRecycleList>>["rows"][number];

// Počty na pilulkách košov: rovnaké filtre ako zoznam, len bez výberu košov.
export async function getRecycleCounts(p: RecycleParams): Promise<Record<RecycleBucket, number>> {
    const rows = await prisma.$queryRaw<{ bucket: RecycleBucket; n: number }[]>`${eligibleCte(p)}
        SELECT c.bucket, count(*)::int AS n FROM c WHERE ${outerFilter(p, "buckets")} GROUP BY c.bucket`;
    const counts = Object.fromEntries(RECYCLE_BUCKETS.map((b) => [b, 0])) as Record<RecycleBucket, number>;
    for (const r of rows) counts[r.bucket] = r.n;
    return counts;
}

// Ponuka „Kto to mal": všetci držitelia kandidátov v zvolených košoch, aj deaktivovaní (timea, spec §2.3).
export async function getRecycleHolders(p: RecycleParams) {
    const rows = await prisma.$queryRaw<{ holder: string | null; n: number }[]>`${eligibleCte(p)}
        SELECT c.holder, count(*)::int AS n FROM c WHERE ${outerFilter(p, "holder")} GROUP BY c.holder`;
    const ids = rows.map((r) => r.holder).filter((id): id is string => Boolean(id));
    const users = ids.length
        ? await prisma.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, firstName: true, lastName: true, deletedAt: true },
          })
        : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows
        .map((r) => {
            const u = r.holder ? byId.get(r.holder) : null;
            return {
                id: r.holder ?? RECYCLE_HOLDER_NONE,
                name: u ? `${u.firstName} ${u.lastName}`.trim() : "Nikto",
                deactivated: Boolean(u?.deletedAt),
                count: r.n,
            };
        })
        .sort((a, b) => b.count - a.count);
}

// „Vybrať prvých N": ten istý filter + metadata potvrdenia aj pre riadky mimo aktuálnej strany.
export async function getRecycleFirst(p: RecycleParams, n: number) {
    const take = Math.max(1, Math.min(RECYCLE_MAX_ITEMS, Math.floor(n)));
    const rows = await prisma.$queryRaw<{
        id: string; revision: number; bucket: RecycleBucket; holder: string | null; last_at: Date; openAsks: RequestContent[] | null; dnc: boolean;
    }[]>`${eligibleCte(p)}
        SELECT c.id, l.revision, c.bucket, c.holder, c.last_at, c.dnc, ${OPEN_ASKS_SQL} AS "openAsks"
          FROM c JOIN "Lead" l ON l.id = c.id
         WHERE ${outerFilter(p)} ORDER BY ${ORDER_SQL[p.sort]} LIMIT ${take}`;
    const names = await holderNames(rows.map((r) => r.holder));
    return rows.map((r) => ({ id: r.id, revision: r.revision, bucket: r.bucket, holderId: r.holder,
        holderName: r.holder ? (names.get(r.holder)?.name ?? "—") : null,
        holderActive: r.holder ? (names.get(r.holder)?.active ?? false) : false,
        lastAt: r.last_at.toISOString(), openAsks: r.openAsks ?? [], doNotCall: r.dnc }));
}

// R02-04: koľko kandidátov s „nevolať" je práve skrytých (rovnaké filtre ako zoznam, vrátane košov).
export async function getRecycleHiddenDoNotCall(p: RecycleParams): Promise<number> {
    if (p.dnc === "show") return 0;
    const shown = { ...p, dnc: "show" as const };
    const rows = await prisma.$queryRaw<{ n: number }[]>`${eligibleCte(shown)}
        SELECT count(*)::int AS n FROM c WHERE ${outerFilter(shown)} AND c.dnc`;
    return rows[0]?.n ?? 0;
}

// Hlavička panelu: koľko práce už čaká, než pridáme ďalšiu.
export async function getRecycleHeader() {
    const [pool, inBatches] = await Promise.all([
        getPoolCount(),
        prisma.lead.count({
            where: { deletedAt: null, status: "NEW", pipelineEnteredAt: null, assignedCallerId: { not: null } },
        }),
    ]);
    return { pool, inBatches, now: Date.now() };
}
