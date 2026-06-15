// prisma/dummySeeds/seedUsers.ts
// Testovacie účty pre všetky 4 role. Spusti: npm run seed:dummy:users
// Prihlasovanie cez /login — všetky majú heslo password123.
import prisma from "@/lib/db";
import bcrypt from "bcrypt";

const USERS = [
    { username: "admin",     firstName: "Admin",  lastName: "Zvonček",  email: "admin@thegrandpoints.com",     role: "ADMIN"     },
    { username: "manager",   firstName: "Marek",  lastName: "Manažér",  email: "manager@thegrandpoints.com",   role: "MANAGER"   },
    { username: "telesales", firstName: "Tina",   lastName: "Telesales",email: "telesales@thegrandpoints.com", role: "TELESALES" },
    { username: "scout",     firstName: "Sára",   lastName: "Scout",    email: "scout@thegrandpoints.com",     role: "SCOUT"     },
] as const;

async function main() {
    const password = await bcrypt.hash("password123", 10);
    for (const u of USERS) {
        await prisma.user.upsert({
            where: { username: u.username },
            update: { role: u.role },
            create: { ...u, password },
        });
        console.log(`✅ ${u.username.padEnd(12)} ${u.role.padEnd(10)} heslo: password123`);
    }
    console.log("\nPrihlás sa cez /login — meno napr. manager, heslo password123.\n");
}

main().finally(() => prisma.$disconnect());
