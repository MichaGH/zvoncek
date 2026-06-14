// prisma/seedTracking.ts
// Vytvorí testovací návrh + tracker, aby si hneď mohol skúšať /api/p (Postman / dev stránka).
// Spusti: npm run seed:tracking
import prisma from "@/lib/db";
import { generateToken } from "@/lib/tracking/tokens";

async function main() {
    const lead = await prisma.lead.findFirst({ orderBy: { number: "asc" } });
    if (!lead) {
        console.log("Žiadny lead v DB – najprv seedni leady.");
        return;
    }

    const token = generateToken();
    await prisma.design.create({
        data: {
            leadId: lead.id,
            label: "Testovací návrh",
            targetUrl: "https://atp.thegrandpoints.com/",
            currentVersion: 1,
            versions: { create: { version: 1, url: "https://atp.thegrandpoints.com/" } },
            tracker: { create: { token } },
        },
    });

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const leadLabel = `#${lead.number} ${lead.companyName ?? lead.website ?? ""}`.trim();

    console.log("\n✅ Tracking seed hotový.\n");
    console.log(`Návrh token: ${token}   → ${leadLabel}`);
    console.log(`\n── Postman ────────────────────────────────────`);
    console.log(`POST ${base}/api/p`);
    console.log(`Body (raw/JSON):  { "p": "${token}", "e": "view" }`);
    console.log(`Engaged:          { "p": "${token}", "e": "engaged", "d": 12000 }`);
    console.log(`\n── Browser ────────────────────────────────────`);
    console.log(`${base}/dev/proposal?p=${token}`);
    console.log(`\nVýsledok: npx prisma studio → TrackerEvent\n`);
}

main().finally(() => prisma.$disconnect());
