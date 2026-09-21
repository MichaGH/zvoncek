// Independent post-migration check (read-only). Run through with-target.mjs:
//   node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --expect ep-x -- npx tsx .ai/migrations/v1-to-v2-live/tools/post-check.ts
// Compares V2 application logic with what the backfills wrote and prints the invariants the runbook checks.
import prisma from "../../../../lib/db";
import { parseOfferMeta, offerInstant } from "../../../../lib/domain/offers";
import { resolveRequests, type ReceiptRow, type RequestRow } from "../../../../lib/domain/clientRequests";

async function main() {
    let bad = 0;
    const flag = (msg: string) => { bad++; console.log("  FAIL", msg); };
    const leads = await prisma.lead.findMany({
        select: {
            id: true, number: true, status: true, pipelineEnteredAt: true, deletedAt: true, nextActionKind: true, ownerId: true,
            requests: { select: { id: true, content: true, state: true, requestedAt: true, resolvedAt: true, resolvedById: true, resolvedActivityId: true, origin: true } },
            activities: { where: { type: "OFFER_SENT" }, select: { id: true, userId: true, createdAt: true, revertedAt: true, meta: true } },
        },
    });
    let reqs = 0, sends = 0;
    for (const l of leads) {
        const receipts: ReceiptRow[] = l.activities.filter((a) => !a.revertedAt).flatMap((a) => {
            const m = parseOfferMeta(a.meta);
            if (!m) { flag(`#${l.number} OFFER_SENT meta invalid`); return []; }
            return [{ id: a.id, userId: a.userId, instant: offerInstant(m, a.createdAt), contents: m.contents }];
        });
        sends += l.activities.length;
        reqs += l.requests.length;
        if (!l.pipelineEnteredAt && (l.activities.length || l.requests.length)) flag(`#${l.number} sends/requests on a non-deal`);
        const rows: RequestRow[] = l.requests.map((r) => ({ ...r }));
        const want = resolveRequests(rows, receipts);
        for (const r of l.requests) {
            const w = want.get(r.id)!;
            if (w.state !== r.state || (w.resolvedActivityId ?? null) !== (r.resolvedActivityId ?? null)) flag(`#${l.number} request ${r.content} db=${r.state} app=${w.state}`);
        }
        const dup = new Set<string>();
        for (const r of l.requests) { if (dup.has(r.content)) flag(`#${l.number} duplicate request ${r.content}`); dup.add(r.content); }
        if (l.pipelineEnteredAt && ["ACTIVE", "SNOOZED"].includes(l.status) && !l.ownerId) flag(`#${l.number} open deal without owner`);
    }
    const q = async (sql: string) => (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql));
    console.log("status x stage:", await q(`select status::text, ("pipelineEnteredAt" is not null) deal, count(*)::int n from "Lead" where "deletedAt" is null group by 1,2 order by 1,2`));
    console.log("open-deal steps:", await q(`select "nextActionKind"::text k, "nextActionMode"::text m, count(*)::int n from "Lead" where "deletedAt" is null and "pipelineEnteredAt" is not null and status in ('ACTIVE','SNOOZED') group by 1,2 order by 1,2`));
    console.log("price total:", await q(`select count(price)::int n, sum(price)::text total from "Lead"`));
    console.log("requests:", await q(`select content::text, state::text, origin::text, count(*)::int n from "LeadRequest" group by 1,2,3 order by 1,2,3`));
    console.log("offer summaries:", await q(`select count("offerAboutUsAt")::int about, count("offerPriceAt")::int price, count("designSentAt")::int design, count("offerPricelistAt")::int pricelist from "Lead"`));
    console.log("team:", await q(`select t.name, l.username leader, (select string_agg(u.username, ',') from "User" u where u."teamId" = t.id) members from "Team" t join "User" l on l.id = t."leaderId" order by 1`));
    console.log(`checked ${leads.length} leads, ${sends} OFFER_SENT, ${reqs} requests`);
    console.log(bad ? `RESULT: ${bad} FAIL` : "RESULT: all post-migration invariants hold");
    process.exitCode = bad ? 1 : 0;
}
main().finally(() => prisma.$disconnect());
