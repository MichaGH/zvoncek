import Link from "next/link";
import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/permissions";
import { getAdminUserList } from "@/lib/queries/users";
import { ROLE_LABEL } from "@/lib/dictionaries";
import { Plus, Pencil } from "lucide-react";
import type { Role } from "@/app/generated/prisma/enums";

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline" | "destructive"> = {
    ADMIN: "destructive",
    MANAGER: "default",
    TELESALES: "secondary",
    SCOUT: "outline",
};

function formatDate(d: Date | null) {
    if (!d) return "—";
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "numeric" });
}

function formatDateTime(d: Date | null) {
    if (!d) return "—";
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "numeric" })
        + " " + d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}

export default async function AdminUsersPage() {
    const session = await auth();
    if (!can(session?.user, "admin.access")) notFound();

    const users = await getAdminUserList();

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Používatelia"
                description={`${users.filter((u) => !u.deletedAt).length} aktívnych · ${users.length} celkom`}
                actions={
                    <Button asChild size="sm">
                        <Link href="/dashboard/admin/users/new">
                            <Plus className="h-4 w-4" />
                            Nový používateľ
                        </Link>
                    </Button>
                }
            />

            <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[700px]">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Meno</TableHead>
                            <TableHead>Username</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead>Rola</TableHead>
                            <TableHead>Posl. prihlásenie</TableHead>
                            <TableHead className="text-right">Vytvorený</TableHead>
                            <TableHead className="w-12" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {users.map((user) => (
                            <TableRow key={user.id} className={user.deletedAt ? "opacity-50" : ""}>
                                <TableCell className="font-medium">
                                    <Link
                                        href={`/dashboard/admin/users/${user.id}`}
                                        className="hover:underline"
                                    >
                                        {user.firstName} {user.lastName}
                                    </Link>
                                    {user.deletedAt && (
                                        <span className="ml-2 text-xs text-muted-foreground">(deaktivovaný)</span>
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-sm text-muted-foreground">
                                    {user.username}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                    {user.email ?? "—"}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={ROLE_VARIANT[user.role]}>{ROLE_LABEL[user.role]}</Badge>
                                </TableCell>
                                <TableCell className="tabular-nums text-sm text-muted-foreground">
                                    {formatDateTime(user.lastLoginAt)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                                    {formatDate(user.createdAt)}
                                </TableCell>
                                <TableCell className="text-right">
                                    <Button asChild size="sm" variant="ghost" className="h-8 w-8 p-0">
                                        <Link href={`/dashboard/admin/users/${user.id}`}>
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Link>
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </DashboardPage>
    );
}
