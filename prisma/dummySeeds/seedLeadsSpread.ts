// prisma/dummySeeds/seedLeads.ts
// Dummy leady pre demo prostredie. Spusti AŽ PO seed:dummy:users.
// npm run seed:dummy:leads
import prisma from "@/lib/db";

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const future = (days: number) => new Date(Date.now() + days * 86_400_000);

async function main() {
    const scout     = await prisma.user.findUnique({ where: { username: "scout" } });
    const telesales = await prisma.user.findUnique({ where: { username: "telesales" } });
    const manager   = await prisma.user.findUnique({ where: { username: "manager" } });

    if (!scout || !telesales || !manager) {
        console.error("❌  Používatelia nenájdení – najprv spusti: npm run seed:dummy:users");
        process.exit(1);
    }

    const leads = [
        // ── NEW ──────────────────────────────────────────────────────────────
        {
            companyName: "Novák & Syn s.r.o.",
            phone: "+421 902 111 222",
            website: "novakasyn.sk",
            status: "NEW",
            origin: "MARKETING_CALL",
            createdById: scout.id,
        },
        {
            companyName: "Reštaurácia Zlatý Gokl",
            phone: "+421 911 333 444",
            status: "NEW",
            origin: "MARKETING_CALL",
            createdById: scout.id,
        },
        {
            companyName: "Autoservis Kráľ s.r.o.",
            phone: "+421 948 555 666",
            website: "autokral.sk",
            status: "NEW",
            origin: "MARKETING_CALL",
            createdById: scout.id,
        },
        {
            companyName: "Pekáreň a Cukráreň Majer",
            phone: "+421 903 777 888",
            status: "NEW",
            origin: "MARKETING_CALL",
            createdById: scout.id,
        },
        {
            companyName: "Studio Ema – grafika & foto",
            phone: "+421 910 999 000",
            email: "ema@studioema.sk",
            status: "NEW",
            origin: "DIRECT",
            createdById: scout.id,
        },
        {
            companyName: "Kebab Express Záhorská",
            phone: "+421 944 100 200",
            status: "NEW",
            origin: "MARKETING_CALL",
            createdById: scout.id,
        },

        // ── CALLING ──────────────────────────────────────────────────────────
        {
            companyName: "FitnessZone Žilina s.r.o.",
            phone: "+421 918 101 102",
            status: "CALLING",
            origin: "MARKETING_CALL",
            callbackKind: "RETRY",
            callbackNote: "Nedvíha, skúsiť zajtra ráno.",
            createdById: scout.id,
        },
        {
            companyName: "Dentálne Centrum Dr. Mináč",
            phone: "+421 907 202 303",
            website: "drmínac.sk",
            status: "CALLING",
            origin: "MARKETING_CALL",
            callbackKind: "SCHEDULED",
            callbackAt: future(1),
            callbackNote: "Zavolaj o 14:00 – dopoludnia ordinuje.",
            createdById: scout.id,
        },
        {
            companyName: "Záhradníctvo Zelený Raj",
            phone: "+421 905 404 505",
            status: "CALLING",
            origin: "MARKETING_CALL",
            callbackKind: "RETRY",
            createdById: scout.id,
        },
        {
            companyName: "Plastové Okná Moravec",
            phone: "+421 911 606 707",
            website: "oknamomoravec.sk",
            status: "CALLING",
            origin: "MARKETING_CALL",
            callbackKind: "SCHEDULED",
            callbackAt: future(3),
            callbackNote: "Pán Moravec – pondelok ráno po 9:00.",
            createdById: scout.id,
        },
        {
            companyName: "Detský Raj s.r.o.",
            phone: "+421 948 808 909",
            status: "CALLING",
            origin: "MARKETING_CALL",
            callbackKind: "RETRY",
            createdById: scout.id,
        },

        // ── ACTIVE ───────────────────────────────────────────────────────────
        {
            companyName: "TechFlow Slovakia s.r.o.",
            phone: "+421 903 111 999",
            website: "techflow.sk",
            email: "info@techflow.sk",
            status: "ACTIVE",
            origin: "MARKETING_CALL",
            projectType: "WEBAPP",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionKind: "SEND_QUOTE",
            nextActionAt: future(2),
            price: "2400.00",
            priceNote: "1 200 € web + 1 200 € admin panel",
        },
        {
            companyName: "Realitná kancelária Panoráma",
            phone: "+421 910 222 888",
            website: "panorama-reality.sk",
            status: "ACTIVE",
            origin: "REFERRAL",
            projectType: "WEBSITE",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionKind: "WAITING_FOR_CLIENT",
            nextActionAt: future(7),
            nextActionNote: "Čakáme na výber fotografií od klientky.",
            quoteSentAt: ago(5),
            price: "890.00",
        },
        {
            companyName: "Reklama & Tlač Agentúra s.r.o.",
            phone: "+421 944 333 777",
            website: "reklamatrlac.sk",
            email: "obchod@reklamatrlac.sk",
            status: "ACTIVE",
            origin: "MARKETING_CALL",
            projectType: "WEBSITE",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionKind: "SEND_DESIGN",
            nextActionAt: future(1),
            price: "750.00",
        },
        {
            companyName: "Slovak Pet Shop",
            phone: "+421 918 444 666",
            email: "petshop@petshop.sk",
            status: "ACTIVE",
            origin: "MARKETING_CALL",
            projectType: "ESHOP",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionKind: "CALL",
            nextActionAt: future(3),
            quoteSentAt: ago(10),
            price: "1600.00",
            priceNote: "900 € eshop + 700 € napojenie na sklad",
        },
        {
            companyName: "Čistý Dom – upratovacie služby",
            phone: "+421 907 555 555",
            website: "cistydom.sk",
            status: "ACTIVE",
            origin: "DIRECT",
            projectType: "WEBSITE",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionKind: "WAITING_FOR_CLIENT",
            nextActionNote: "Klient dostal návrh, čakáme na feedback.",
            designSentAt: ago(3),
            price: "690.00",
        },

        // ── SNOOZED ──────────────────────────────────────────────────────────
        {
            companyName: "Hotelový Komplex Devín",
            phone: "+421 902 101 010",
            website: "hoteldevin.sk",
            status: "SNOOZED",
            origin: "MARKETING_CALL",
            ownerId: manager.id,
            createdById: scout.id,
            nextActionAt: future(120),
            nextActionNote: "Rekonštrukcia trvá celé leto – osloviť na jeseň.",
        },
        {
            companyName: "Stavebná Firma Horváth s.r.o.",
            phone: "+421 911 202 020",
            status: "SNOOZED",
            origin: "MARKETING_CALL",
            createdById: scout.id,
            nextActionAt: future(60),
            nextActionNote: "\"O 2 mesiace zákazky poľavia, vtedy na to budeme mať čas.\"",
        },

        // ── WON ──────────────────────────────────────────────────────────────
        {
            companyName: "Optika Vidíme Dobre s.r.o.",
            phone: "+421 905 303 030",
            website: "vidimeobre.sk",
            email: "info@vidimeobre.sk",
            status: "WON",
            origin: "MARKETING_CALL",
            projectType: "WEBSITE",
            ownerId: manager.id,
            createdById: scout.id,
            price: "890.00",
            quoteSentAt: ago(30),
            designSentAt: ago(15),
        },
        {
            companyName: "Café Amadeus Bratislava",
            phone: "+421 948 404 040",
            website: "cafeamadeus.sk",
            email: "cafamadeus@gmail.com",
            status: "WON",
            origin: "REFERRAL",
            projectType: "WEBSITE",
            ownerId: manager.id,
            createdById: scout.id,
            price: "690.00",
            quoteSentAt: ago(45),
            aboutUsSentAt: ago(40),
        },

        // ── LOST ─────────────────────────────────────────────────────────────
        {
            companyName: "Mäsiarstvo Novotný s.r.o.",
            phone: "+421 910 505 050",
            status: "LOST",
            origin: "MARKETING_CALL",
            createdById: scout.id,
            lostReason: "Nemajú záujem o web, klientela chodí priamo.",
        },
        {
            companyName: "Distribúcia Kovač & Co.",
            phone: "+421 944 606 060",
            website: "kovac-dist.sk",
            status: "LOST",
            origin: "MARKETING_CALL",
            createdById: scout.id,
            lostReason: "Web práve redizajnoval ich bratranec – \"ozve sa neskôr\".",
        },

        // ── UNREACHABLE ───────────────────────────────────────────────────────
        {
            companyName: "Kvetinárstvo Kvety Evi",
            phone: "+421 902 707 070",
            status: "UNREACHABLE",
            origin: "MARKETING_CALL",
            createdById: scout.id,
            lostReason: "Číslo neexistuje.",
        },
    ];

    let count = 0;
    for (const lead of leads) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await prisma.lead.create({ data: lead as any });
        count++;
        console.log(`  [${lead.status.padEnd(12)}] ${lead.companyName}`);
    }

    console.log(`\n✅ Seednutých ${count} dummy leadov.\n`);
}

main().finally(() => prisma.$disconnect());
