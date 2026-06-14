// prisma/seedTracking.ts
// Creates test tracked links so you can immediately poke /api/p with Postman.
// Run: npm run seed:tracking
import prisma from "@/lib/db";
import { generateToken } from "@/lib/tracking/tokens";

async function main() {
    const lead = await prisma.lead.findFirst({ orderBy: { number: "asc" } });

    const leadToken = generateToken();
    await prisma.trackedLink.create({
        data: {
            token: leadToken,
            kind: "DESIGN",
            leadId: lead?.id ?? null,
            label: "Testovací dizajn",
            targetUrl: "http://127.0.0.1:5500/proposal.html",
            currentVersion: 1,
            versions: {
                create: { version: 1, url: "http://127.0.0.1:5500/proposal.html" },
            },
        },
    });

    const standaloneToken = generateToken();
    await prisma.trackedLink.create({
        data: {
            token: standaloneToken,
            kind: "OTHER",
            label: "Samostatný test tracker",
            currentVersion: 1,
            versions: { create: { version: 1 } },
        },
    });

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const leadLabel = lead
        ? `#${lead.number} ${lead.companyName ?? lead.website ?? ""}`.trim()
        : "(žiadny lead v DB)";

    console.log("\n✅ Tracking seed hotový.\n");
    console.log(`Lead tracker token:       ${leadToken}   → ${leadLabel}`);
    console.log(`Standalone tracker token: ${standaloneToken}`);
    console.log(`\n── Postman test ───────────────────────────────`);
    console.log(`POST ${base}/api/p`);
    console.log(`Body (raw / JSON):  { "p": "${leadToken}", "e": "view" }`);
    console.log(`Then "engaged":     { "p": "${leadToken}", "e": "engaged", "d": 12000 }`);
    console.log(`\n── Browser test ───────────────────────────────`);
    console.log(`${base}/dev/proposal?p=${leadToken}`);
    console.log(`\nPozri výsledok:  npx prisma studio  →  TrackedEvent\n`);
}

main().finally(() => prisma.$disconnect());
