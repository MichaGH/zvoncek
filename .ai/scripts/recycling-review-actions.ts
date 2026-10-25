// Skutočné server actions: oprávnenia recyklácie a scout edit/delete, bez browser-only capability hintov.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { encode } from "next-auth/jwt";
import prisma from "../../lib/db";
import { recycleLeadsAs } from "../../lib/commands/recycling";
import type { AccessUser } from "../../lib/access/user";
import type { Role } from "../../app/generated/prisma/enums";
const base = "http://localhost:3100";
const endpoint = new URL(process.env.DATABASE_URL!).hostname.split(".")[0].replace(/-pooler$/, "");
if (endpoint !== "ep-divine-waterfall-asbkuort") throw new Error("ABORT: dev copy only");
const run = `rvact_${Date.now().toString(36)}`;
const users: string[] = [];
const ids: string[] = [];
const teams: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail = "") { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); }
async function user(role: Role): Promise<AccessUser> {
    const u = await prisma.user.create({ data: { username: `${run}${users.length}`.slice(-20), firstName: run, lastName: role, role, password: "unused-fixture" } });
    users.push(u.id);
    return u;
}
async function cookie(u: AccessUser) {
    return `authjs.session-token=${await encode({ token: { sub: u.id, id: u.id, role: u.role, username: u.username }, secret: process.env.AUTH_SECRET!, salt: "authjs.session-token" })}`;
}
type Manifest = { node: Record<string, { exportedName: string; filename: string }> };
async function action(actor: AccessUser, name: string, args: unknown[]) {
    const m = JSON.parse(readFileSync(".next/dev/server/server-reference-manifest.json", "utf8")) as Manifest;
    const id = Object.entries(m.node).find(([, v]) => v.exportedName === name)?.[0];
    if (!id) throw new Error(`Action ${name} not compiled`);
    const path = name === "recycleLeads" || name === "pickRecycleFirst" ? "/dashboard/admin/recycle" : "/dashboard/contacts";
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { cookie: await cookie(actor), origin: base, "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) });
    return { status: r.status, body: await r.text() };
}
async function main() {
    const admin = await user("ADMIN");
    const scout = await user("SCOUT");
    const leader = await user("SCOUT_LEADER");
    const manager = await user("MANAGER");
    const team = await prisma.team.create({ data: { name: run, leaderId: leader.id } });
    teams.push(team.id);
    await prisma.user.update({ where: { id: scout.id }, data: { teamId: team.id } });
    const l = await prisma.lead.create({ data: { companyName: run, phone: "+000 123", createdById: scout.id, status: "LOST" } });
    ids.push(l.id);
    await recycleLeadsAs(admin, { items: [{ leadId: l.id, expectedRevision: 0 }] });
    await fetch(`${base}/dashboard/contacts`, { headers: { cookie: await cookie(admin) } }).then((r) => r.text());
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    for (const actor of [scout, leader]) {
        const edit = await action(actor, "updateContact", [l.id, { companyName: "forged edit", phone: "+000 456" }]);
        const del = await action(actor, "deleteContact", [l.id]);
        check(`${actor.role}: server refuses edit and delete of recycled contact`, edit.status === 200 && del.status === 200 && edit.body.includes('"ok":false') && del.body.includes('"ok":false'), `HTTP ${edit.status}/${del.status}`);
    }
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    check("denied actions leave identity, data, revision and soft-delete unchanged", after.companyName === before.companyName && after.phone === before.phone && after.revision === before.revision && after.deletedAt === null);
    const fresh = await prisma.lead.create({ data: { companyName: run, phone: "+000 123", createdById: scout.id } });
    ids.push(fresh.id);
    const control = await action(scout, "updateContact", [fresh.id, { companyName: `${run} edited`, phone: "+000 789" }]);
    check("control: scout can still edit untouched first-round contact", control.status === 200 && control.body.includes('"ok":true'));
    const recyclable = await prisma.lead.create({ data: { companyName: run, status: "LOST" } });
    ids.push(recyclable.id);
    // Stará ADMIN rola v podpísanom JWT pustí proxy, DB rola musí aj tak odmietnuť samotný endpoint.
    const noManager = await action({ ...manager, role: "ADMIN" }, "recycleLeads", [{ items: [{ leadId: recyclable.id, expectedRevision: 0 }] }]);
    const noScout = await action({ ...scout, role: "ADMIN" }, "recycleLeads", [{ items: [{ leadId: recyclable.id, expectedRevision: 0 }] }]);
    check("manager/scout with stale ADMIN JWT cannot call recycle server action directly", noManager.body.includes('"code":"FORBIDDEN"') && noScout.body.includes('"code":"FORBIDDEN"'), `HTTP ${noManager.status}/${noScout.status}`);
    const final = await prisma.lead.findUniqueOrThrow({ where: { id: recyclable.id } });
    check("unauthorized recycle performs no write", final.round === 1 && final.revision === 0 && final.status === "LOST");

    const wanted = await prisma.lead.create({ data: { companyName: `${run}_wanted`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: admin.id,
        requests: { create: { content: "DESIGN", requestedAt: new Date() } } } });
    ids.push(wanted.id);
    const query = { b: "deal_active", older: "0", q: `${run}_wanted`, asked: "DESIGN" };
    const picked = await action(admin, "pickRecycleFirst", [query, 500]);
    check("actual first-N action carries owner/request/date snapshot", picked.status === 200 && picked.body.includes(wanted.id)
        && picked.body.includes('"holderId":"' + admin.id + '"') && picked.body.includes('"openAsks":["DESIGN"]') && picked.body.includes('"lastAt":'));
    const deniedPick = await action({ ...manager, role: "ADMIN" }, "pickRecycleFirst", [query, 500]);
    check("manager with stale ADMIN session cannot obtain first-N data", deniedPick.body.includes('"code":"FORBIDDEN"') && !deniedPick.body.includes(wanted.id));
    const input = { items: [{ leadId: wanted.id, expectedRevision: 0 }] };
    // Model a client losing the success response: keep the original selection and submit it again.
    // This is local response-discard coverage, not a claim about deployed disconnect/cancellation behavior.
    const firstResponse = await action(admin, "recycleLeads", [input]);
    check("actual recycle action returns success", firstResponse.status === 200 && firstResponse.body.includes('"recycled":1'));
    const retried = await action(admin, "recycleLeads", [input]);
    const afterRetry = await prisma.lead.findUniqueOrThrow({ where: { id: wanted.id } });
    check("HTTP retry of discarded success makes no second round", retried.status === 200 && retried.body.includes('"recycled":1')
        && afterRetry.round === 2 && afterRetry.revision === 1 && await prisma.lead.count({ where: { archiveOfId: wanted.id } }) === 1);
}
main().catch((e) => { failures++; console.error(e); }).finally(async () => {
    const archives = await prisma.lead.findMany({ where: { archiveOfId: { in: ids } }, select: { id: true } });
    const all = [...ids, ...archives.map((a) => a.id)];
    await prisma.activity.deleteMany({ where: { leadId: { in: all } } });
    await prisma.lead.deleteMany({ where: { id: { in: archives.map((a) => a.id) } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.updateMany({ where: { id: { in: users } }, data: { teamId: null } });
    await prisma.team.deleteMany({ where: { id: { in: teams } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    console.log(`cleanup complete; failures=${failures}`);
    process.exitCode = failures ? 1 : 0;
});
