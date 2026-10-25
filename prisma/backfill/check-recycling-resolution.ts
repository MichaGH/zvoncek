// R01 fixes: real request-filter parity and selection metadata, plus pure summary/page boundaries.
// npx tsx prisma/backfill/check-recycling-resolution.ts --expect-endpoint ep-divine-waterfall-asbkuort
import "dotenv/config";
import { encode } from "next-auth/jwt";
import prisma from "../../lib/db";
import { getRecycleCounts, getRecycleFirst, getRecycleHolders, getRecycleList } from "../../lib/queries/recycling";
import { parseRecycleParams, recycleHref, recyclePage, recycleSelection, summarizeRecycleSelection, RECYCLE_BUCKETS, RECYCLE_ASKED } from "../../lib/domain/recycling";
import { recycleLeadsAs } from "../../lib/commands/recycling";
import type { Prisma } from "../../app/generated/prisma/client";

const ep = new URL(process.env.DATABASE_URL ?? "postgres://x/none").hostname.split(".")[0].replace(/-pooler$/, "");
if (ep !== "ep-divine-waterfall-asbkuort" || process.argv[process.argv.indexOf("--expect-endpoint") + 1] !== ep) throw new Error("ABORT: development endpoint required");
const run = `rvfix_${Date.now().toString(36)}`, ids: string[] = [], users: string[] = [];
let checks = 0, failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    checks++; if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function lead(data: Prisma.LeadUncheckedCreateInput = {}) {
    const l = await prisma.lead.create({ data: { companyName: run, status: "ACTIVE", pipelineEnteredAt: new Date(), createdAt: new Date("2020-01-01Z"), ...data } });
    ids.push(l.id); return l;
}
async function main() {
    console.log(`endpoint=${ep} run=${run}`);
    const admin = await prisma.user.create({ data: { username: `${run}a`, firstName: "Same", lastName: "Owner", role: "ADMIN", password: "unused" } });
    users.push(admin.id);
    const other = await prisma.user.create({ data: { username: `${run}b`, firstName: "Same", lastName: "Owner", role: "SALES_REP", deletedAt: new Date(), password: "unused" } });
    users.push(other.id);
    const p = parseRecycleParams({ b: RECYCLE_BUCKETS.join(","), older: "0", q: run, sort: "number" });
    const wanted = new Map<string, string[]>();
    for (const content of RECYCLE_ASKED) {
        const open = await lead({ ownerId: admin.id });
        wanted.set(content, [open.id]);
        await prisma.leadRequest.createMany({ data: [0, 1].map(() => ({ leadId: open.id, requestedAt: new Date(), content, state: "OPEN" as const })) });
        for (const state of ["SENT", "WITHDRAWN"] as const) {
            const closed = await lead({ ownerId: other.id });
            await prisma.leadRequest.create({ data: { leadId: closed.id, requestedAt: new Date(), content, state } });
        }
        const archived = await lead({ ownerId: other.id });
        await prisma.leadRequest.create({ data: { leadId: archived.id, requestedAt: new Date(), content } });
        await recycleLeadsAs(admin, { items: [{ leadId: archived.id, expectedRevision: 0 }] });
        const call = await lead({ status: "LOST", pipelineEnteredAt: null });
        await prisma.leadRequest.create({ data: { leadId: call.id, requestedAt: new Date(), content } });
    }
    const repeat = await lead({ ownerId: other.id, designSentAt: new Date(), status: "SNOOZED" });
    await prisma.leadRequest.createMany({ data: [{ leadId: repeat.id, requestedAt: new Date(), content: "DESIGN", state: "SENT" }, { leadId: repeat.id, requestedAt: new Date(), content: "DESIGN", state: "OPEN" }] });
    wanted.get("DESIGN")!.push(repeat.id);
    for (const asked of RECYCLE_ASKED) {
        const params = { ...p, asked };
        const [list, counts, holders, first] = await Promise.all([getRecycleList(params), getRecycleCounts(params), getRecycleHolders(params), getRecycleFirst(params, 500)]);
        check(`${asked}: exact OPEN deal IDs, excludes SENT/WITHDRAWN/archive/call-stage`, same(list.rows.map((r) => r.id).sort(), wanted.get(asked)!.sort()));
        check(`${asked}: repeated requests counted once across list/counts/holders/first-N`, list.total === wanted.get(asked)!.length
            && Object.values(counts).reduce((a, b) => a + b, 0) === list.total && holders.reduce((a, h) => a + h.count, 0) === list.total
            && same(first.map((r) => r.id), list.rows.map((r) => r.id)));
        check(`${asked}: URL round trip preserves all filters`, same(parseRecycleParams(Object.fromEntries(new URL(recycleHref(params, { page: 2 }), "http://local").searchParams)), { ...params, page: 2 }));
        check(`${asked}: first-N carries identical warning metadata`, same(first.map(recycleSelection), list.rows.map(recycleSelection)));
    }
    const combined = await getRecycleList({ ...p, asked: "DESIGN", got: "design" });
    check("received design and later OPEN design request compose", combined.total === 1 && combined.rows[0].id === repeat.id);
    check("invalid request filter ignored; page input bounded", parseRecycleParams({ asked: "PRICE OR true", page: "1e30" }).asked === null && parseRecycleParams({ page: "1e30" }).page === 1);

    // More than one page: warning metadata must include rows not in the rendered page.
    const pagePrefix = `${run}_pages`;
    for (let i = 0; i < 102; i++) await lead({ companyName: pagePrefix, ownerId: i < 100 ? admin.id : other.id,
        status: i < 100 ? "ACTIVE" : "SNOOZED", createdAt: i < 100 ? new Date("2020-01-01Z") : new Date(),
        requests: i < 100 ? undefined : { create: { content: "DESIGN", requestedAt: new Date() } } });
    const pages = { ...p, q: pagePrefix };
    const [page1, page2, first] = await Promise.all([getRecycleList(pages), getRecycleList({ ...pages, page: 2 }), getRecycleFirst(pages, 102)]);
    const manual = new Map([...page1.rows, ...page2.rows].map((r) => [r.id, recycleSelection(r)]));
    const summary = summarizeRecycleSelection(manual.values(), Date.now());
    const auto = summarizeRecycleSelection(first.map(recycleSelection), Date.now());
    check("manual cross-page and first-N summaries equal", same(summary, auto));
    check("owner counts keyed by id even when names match; inactive owner retained", summary.owners.length === 2
        && summary.owners.some((o) => o.id === admin.id && o.active === 100 && o.snoozed === 0)
        && summary.owners.some((o) => o.id === other.id && o.active === 0 && o.snoozed === 2));
    check("off-page open design promises and recency counted", same(summary.asks, [{ content: "DESIGN", n: 2 }]) && summary.recent === 2);
    const edgeTime = Date.parse("2026-10-25T12:00:00Z"), cutoff = edgeTime - 30 * 86_400_000;
    const sample = recycleSelection(first[0]);
    const boundary = summarizeRecycleSelection([
        { ...sample, lastAt: new Date(cutoff).toISOString(), bucket: "call_unreachable", openAsks: ["INFO", "INFO"] },
        { ...sample, lastAt: new Date(cutoff - 1).toISOString(), bucket: "call_scheduled" },
        { ...sample, holderId: null, holderName: null, lastAt: new Date(edgeTime).toISOString() },
    ], edgeTime);
    check("warning boundaries, no-owner, duplicate request content and special buckets", boundary.recent === 2 && boundary.owners[0]?.name === "Bez vlastníka"
        && same(boundary.asks, [{ content: "INFO", n: 1 }]) && boundary.buckets.some((b) => b.bucket === "call_unreachable" && b.n === 1)
        && boundary.buckets.some((b) => b.bucket === "call_scheduled" && b.n === 1));
    const recycled = await recycleLeadsAs(admin, { items: page2.rows.map((r) => ({ leadId: r.id, expectedRevision: r.revision })) });
    const shrunk = await getRecycleList({ ...pages, page: 2 });
    check("102→100 recycling normalizes to accessible first page", "recycled" in recycled && recycled.recycled === 2 && shrunk.total === 100 && recyclePage(2, shrunk.total) === 1);
    check("page boundaries 201→200, empty list and manual out-of-range", recyclePage(3, 200) === 2 && recyclePage(9, 0) === 1 && recyclePage(999, 201) === 3 && recyclePage(2, 201) === 2);

    if (process.argv.includes("--http")) {
        // Exercise the server component redirect, including externally shrinking lists.
        const cookie = `authjs.session-token=${await encode({ token: { sub: admin.id, id: admin.id, role: admin.role, username: admin.username },
            secret: process.env.AUTH_SECRET!, salt: "authjs.session-token" })}`;
        const base = "http://localhost:3100";
        const expectPage = async (label: string, total: number, requested: number, expected: number) => {
            const pageName = `${run}_http_${label}`;
            const pageIds = Array.from({ length: total }, (_, i) => `${pageName}_${i}`);
            ids.push(...pageIds);
            await prisma.lead.createMany({ data: pageIds.map((id) => ({ id, companyName: pageName, status: "LOST", createdAt: new Date("2020-01-01Z") })) });
            const params = parseRecycleParams({ b: "call_lost", q: pageName, older: "0", sort: "number", page: String(requested), holder: "none", round: "1" });
            const response = await fetch(base + recycleHref(params, { page: requested }), { headers: { cookie }, redirect: "follow" });
            const html = await response.text(), actual = new URL(response.url);
            const encodedRedirect = new URL(recycleHref(params, { page: expected }), base);
            // Next may send a 200 streaming redirect; assert its canonical target as well as HTTP redirects.
            check(`HTTP ${label}: page ${requested}→${expected}, filters preserved`, response.ok
                && (actual.href === encodedRedirect.href || html.includes(encodedRedirect.pathname + encodedRedirect.search.replaceAll("&", "&amp;"))
                    || html.includes(`NEXT_REDIRECT;replace;${encodedRedirect.pathname}${encodedRedirect.search};`)));
            const landed = await fetch(encodedRedirect.href, { headers: { cookie } }).then((r) => r.text());
            check(`HTTP ${label}: destination renders candidates or honest empty state`, total === 0 ? landed.includes("Nič nezodpovedá filtrom.") : landed.includes(pageName));
        };
        await expectPage("201to200", 200, 3, 2);
        await expectPage("empty", 0, 9, 1);
        await expectPage("manual", 201, 999, 3);
    }
}
main().catch((e) => { failures++; console.error(e); }).finally(async () => {
    try {
        const archives = await prisma.lead.findMany({ where: { archiveOfId: { in: ids } }, select: { id: true } });
        await prisma.lead.deleteMany({ where: { id: { in: archives.map((a) => a.id) } } });
        await prisma.lead.deleteMany({ where: { id: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        console.log(`cleanup complete; ${checks - failures}/${checks} passed; failures=${failures}`);
    } finally { await prisma.$disconnect(); process.exitCode = failures ? 1 : 0; }
});
