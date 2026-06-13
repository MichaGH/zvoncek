// prisma/seed.ts
import prisma from '@/lib/db'; // uprav cestu podľa toho, kde db.ts reálne je
import bcrypt from "bcrypt";

async function main() {
    console.log("DATABASE_URL:", process.env.DATABASE_URL);

    const hashed = await bcrypt.hash("password123", 10);
    await prisma.user.upsert({
        where: { username: "mrkvickaj" },
        update: {},
        create: {
            email: "markvickaj@gmail.com",
            username: "mrkvickaj",
            firstName: "Ján",
            lastName: "Mrkvička",
            password: hashed,
            role: "ADMIN"
        },
    });
    console.log("Seeded ✅");
}

main().finally(() => prisma.$disconnect());
