"use client";

import { useState, useTransition } from "react";
import { Pencil, X, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { adminUpdateUser } from "@/lib/actions/admin";
import { ROLE_LABEL } from "@/lib/dictionaries";
import type { AdminUserDetail } from "@/lib/queries/users";
import type { Role } from "@/app/generated/prisma/enums";

const ROLES: Role[] = ["SCOUT", "TELESALES", "MANAGER", "ADMIN"];

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline" | "destructive"> = {
    ADMIN: "destructive",
    MANAGER: "default",
    TELESALES: "secondary",
    SCOUT: "outline",
};

type Props = { user: AdminUserDetail };

export default function UserProfileCard({ user }: Props) {
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
            const result = await adminUpdateUser(user.id, fd);
            if (!result.ok) { setError(result.error); return; }
            setEditing(false);
            setError(null);
        });
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Profil</CardTitle>
                {!editing ? (
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setEditing(true); setError(null); }}>
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                ) : (
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setEditing(false); setError(null); }}>
                        <X className="h-3.5 w-3.5" />
                    </Button>
                )}
            </CardHeader>
            <CardContent>
                {!editing ? (
                    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-muted-foreground">Meno</dt>
                        <dd className="font-medium">{user.firstName} {user.lastName}</dd>
                        <dt className="text-muted-foreground">Username</dt>
                        <dd className="font-mono text-sm">{user.username}</dd>
                        <dt className="text-muted-foreground">Email</dt>
                        <dd>{user.email ?? <span className="text-muted-foreground">—</span>}</dd>
                        <dt className="text-muted-foreground">Telefón</dt>
                        <dd>{user.phone ?? <span className="text-muted-foreground">—</span>}</dd>
                        <dt className="text-muted-foreground">Rola</dt>
                        <dd><Badge variant={ROLE_VARIANT[user.role]}>{ROLE_LABEL[user.role]}</Badge></dd>
                        {user.note && (
                            <>
                                <dt className="text-muted-foreground">Poznámka</dt>
                                <dd className="text-muted-foreground">{user.note}</dd>
                            </>
                        )}
                    </dl>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="firstName">Meno</Label>
                                <Input id="firstName" name="firstName" defaultValue={user.firstName} required />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="lastName">Priezvisko</Label>
                                <Input id="lastName" name="lastName" defaultValue={user.lastName} required />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="username">Username</Label>
                            <Input id="username" name="username" defaultValue={user.username} required className="font-mono" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="email">Email</Label>
                                <Input id="email" name="email" type="email" defaultValue={user.email ?? ""} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="phone">Telefón</Label>
                                <Input id="phone" name="phone" type="tel" defaultValue={user.phone ?? ""} />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="role">Rola</Label>
                            <select
                                id="role" name="role"
                                defaultValue={user.role}
                                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            >
                                {ROLES.map((r) => (
                                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="note">Interná poznámka</Label>
                            <Input id="note" name="note" defaultValue={user.note ?? ""} placeholder="len pre admina…" />
                        </div>
                        {error && <p className="text-sm text-destructive">{error}</p>}
                        <div className="flex gap-2">
                            <Button type="submit" size="sm" disabled={pending}>
                                <Check className="mr-1.5 h-3.5 w-3.5" />
                                {pending ? "Ukladám…" : "Uložiť"}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setEditing(false); setError(null); }}>
                                Zrušiť
                            </Button>
                        </div>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}
