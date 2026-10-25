import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import bcrypt from "bcrypt";
import prisma from "../../lib/db";
const endpoint = new URL(process.env.DATABASE_URL!).hostname.split(".")[0].replace(/-pooler$/, "");
if (endpoint !== "ep-divine-waterfall-asbkuort") throw new Error("ABORT: dev copy only");
const path = ".ai/recycling-review-ui.json";
type State = { userId: string; username: string; ids: string[]; prefix: string; activeId: string; lostNumber: number };
async function main() {
    const mode = process.argv[2];
    if (mode === "verify-cleanup") {
        console.log(JSON.stringify({ endpoint, database: (await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0].name,
            reviewLeads: await prisma.lead.count({ where: { OR: [{ companyName: { startsWith: "R02UI" } }, { companyName: { startsWith: "rv02_" } }, { companyName: { startsWith: "rvact_" } }, { companyName: { startsWith: "rv2b_" } }] } }),
            reviewUsers: await prisma.user.count({ where: { OR: [{ firstName: { startsWith: "rv02_" } }, { firstName: { startsWith: "rvact_" } }, { firstName: { startsWith: "rv2b_" } }, { username: { startsWith: "rvui_" } }, { username: { startsWith: "cc_mvo7nt86" } }] } }),
            suiteLeads: await prisma.lead.count({ where: { companyName: { startsWith: "CC-TEST mvo7nt86" } } }),
            visibleArchives: await prisma.lead.count({ where: { archiveOfId: { not: null }, deletedAt: null } }),
            newWithCalls: await prisma.lead.count({ where: { deletedAt: null, status: "NEW", activities: { some: { type: "CALL" } } } }),
        }));
        return;
    }
    if (mode === "setup") {
        const prefix = `R02UI${Date.now().toString(36)}`;
        const username = `rvui_${Date.now().toString(36)}`;
        const user = await prisma.user.create({ data: { username, firstName: "Review", lastName: "Caller", role: "TELESALES", password: await bcrypt.hash("password123", 4) } });
        const admin = await prisma.user.findUniqueOrThrow({ where: { username: "michal" } });
        const ids = Array.from({ length: 103 }, (_, i) => `${prefix}_${String(i).padStart(3, "0")}`);
        await prisma.lead.createMany({ data: ids.map((id, i) => ({ id, companyName: `${prefix} ${i}`, phone: "+000 000 000", status: "LOST", createdAt: new Date("2020-01-01Z") })) });
        await prisma.activity.createMany({ data: ids.map((leadId) => ({ leadId, userId: user.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "NOT_INTERESTED", leadRevision: 0, createdAt: new Date("2020-02-01Z") })) });
        const active = await prisma.lead.create({ data: { companyName: `${prefix} Active`, status: "ACTIVE", phone: "+000 000 000", pipelineEnteredAt: new Date("2020-02-01Z"), ownerId: admin.id, createdAt: new Date("2020-01-01Z"), requests: { create: { content: "DESIGN", requestedAt: new Date("2020-02-01Z") } } } });
        await prisma.activity.create({ data: { leadId: active.id, userId: user.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "INTERESTED", leadRevision: 0, createdAt: new Date("2020-02-01Z") } });
        const first = await prisma.lead.findUniqueOrThrow({ where: { id: ids[0] } });
        const state: State = { userId: user.id, username, prefix, ids: [...ids, active.id], activeId: active.id, lostNumber: first.number };
        writeFileSync(path, JSON.stringify(state));
        console.log(JSON.stringify(state));
        return;
    }
    const state = JSON.parse(readFileSync(path, "utf8")) as State;
    if (mode === "stale") {
        await prisma.lead.update({ where: { id: state.ids[0] }, data: { revision: { increment: 1 } } });
        console.log("first fixture revision changed");
    } else if (mode === "claim-ready") {
        const recycled = await prisma.lead.findFirstOrThrow({ where: { id: { in: state.ids }, round: 2, status: "NEW" } });
        await prisma.lead.update({ where: { id: recycled.id }, data: { roundStartedAt: new Date("1990-01-01Z") } });
        const fillerIds = Array.from({ length: 9 }, (_, i) => `${state.prefix}_filler_${i}`);
        await prisma.lead.createMany({ data: fillerIds.map((id) => ({ id, companyName: `${state.prefix} filler`, createdAt: new Date("1990-01-02Z") })) });
        state.ids.push(...fillerIds);
        writeFileSync(path, JSON.stringify(state));
        console.log(JSON.stringify({ username: state.username, number: recycled.number }));
    } else if (mode === "state") {
        console.log(await prisma.lead.findMany({ where: { id: { in: state.ids }, OR: [{ round: { gt: 1 } }, { id: state.activeId }] }, select: { id: true, number: true, revision: true, round: true, status: true, assignedCallerId: true } }));
    } else if (mode === "cleanup") {
        const archives = await prisma.lead.findMany({ where: { archiveOfId: { in: state.ids } }, select: { id: true } });
        const all = [...state.ids, ...archives.map((a) => a.id)];
        await prisma.leadRequest.deleteMany({ where: { leadId: { in: all } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: all } } });
        await prisma.lead.deleteMany({ where: { id: { in: archives.map((a) => a.id) } } });
        await prisma.lead.deleteMany({ where: { id: { in: state.ids } } });
        await prisma.user.delete({ where: { id: state.userId } });
        console.log("UI fixture cleanup complete");
    } else throw new Error("Expected setup/stale/claim-ready/state/cleanup");
}
main().finally(() => prisma.$disconnect());
