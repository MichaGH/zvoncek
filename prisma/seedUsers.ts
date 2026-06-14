// prisma/seedUsers.ts
// Testovacie účty pre jednotlivé role. Spusti: npm run seed:users
// Prihlasovanie cez /login: meno + heslo (všetky majú "password123").
import prisma from "@/lib/db";
import bcrypt from "bcrypt";
import type { Role } from "@/app/generated/prisma/enums";

const USERS: {
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    role: Role;
}[] = [
    { username: "admin", firstName: "Admin", lastName: "Zvonček", email: "admin@thegrandpoints.com", role: "ADMIN" },
    { username: "manager", firstName: "Marek", lastName: "Manažér", email: "manager@thegrandpoints.com", role: "MANAGER" },
    { username: "telesales", firstName: "Tina", lastName: "Telesales", email: "telesales@thegrandpoints.com", role: "TELESALES" },
    { username: "scout", firstName: "Sára", lastName: "Scout", email: "scout@thegrandpoints.com", role: "SCOUT" },
];

async function main() {
    const password = await bcrypt.hash("password123", 10);
    for (const u of USERS) {
        await prisma.user.upsert({
            where: { username: u.username },
            update: { role: u.role }, // pri opätovnom spustení len zosúladí rolu
            create: { ...u, password },
        });
        console.log(`✅ ${u.username.padEnd(10)} ${u.role.padEnd(10)} heslo: password123`);
    }
    console.log("\nPrihlás sa cez /login — meno napr. admin, heslo password123.\n");
}

main().finally(() => prisma.$disconnect());
