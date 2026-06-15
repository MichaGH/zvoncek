import prisma from "@/lib/db";
import bcrypt from "bcrypt";

async function main() {
    const password = await bcrypt.hash("password123", 10);
    const user = await prisma.user.upsert({
        where: { username: "michal" },
        update: { role: "ADMIN", password },
        create: {
            username: "michal",
            firstName: "Michal",
            lastName: "Chovanec",
            email: "yungloremain@gmail.com",
            role: "ADMIN",
            password,
        },
    });
    console.log(`\n✅ Admin vytvorený`);
    console.log(`   Meno:  ${user.firstName} ${user.lastName}`);
    console.log(`   Login: michal`);
    console.log(`   Heslo: password123  ← zmeň si ho v /dashboard/admin/users/${user.id}\n`);
}

main().finally(() => prisma.$disconnect());
