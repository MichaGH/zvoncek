"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminCreateUser } from "@/lib/actions/admin";
import { ROLE_LABEL } from "@/lib/dictionaries";
import type { Role } from "@/app/generated/prisma/enums";

const ROLES: Role[] = ["SCOUT", "TELESALES", "MANAGER", "ADMIN"];

const PASSWORD_CHECKS = [
    { label: "Aspoň 8 znakov", test: (p: string) => p.length >= 8 },
    { label: "Veľké písmeno", test: (p: string) => /[A-Z]/.test(p) },
    { label: "Číslo", test: (p: string) => /[0-9]/.test(p) },
];

export default function NewUserForm() {
    const router = useRouter();
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const checksOk = PASSWORD_CHECKS.every((c) => c.test(password));

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!checksOk) return;
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
            const result = await adminCreateUser(fd);
            if (!result.ok) { setError(result.error); return; }
            router.push(`/dashboard/admin/users/${result.data!.id}`);
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Údaje nového používateľa</CardTitle>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="firstName">Meno *</Label>
                            <Input id="firstName" name="firstName" required placeholder="Jana" />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="lastName">Priezvisko *</Label>
                            <Input id="lastName" name="lastName" required placeholder="Nováková" />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="username">Username *</Label>
                        <Input id="username" name="username" required placeholder="jana_novakova" className="font-mono" />
                        <p className="text-xs text-muted-foreground">Len malé písmená, čísla a podčiarkovník. Nedá sa zmeniť po vytvorení (ale dá, adminom).</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="email">Email</Label>
                            <Input id="email" name="email" type="email" placeholder="jana@thegrandpoints.com" />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="phone">Telefón</Label>
                            <Input id="phone" name="phone" type="tel" placeholder="0905 123 456" />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="role">Rola *</Label>
                        <select
                            id="role" name="role" required
                            defaultValue="SCOUT"
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                            {ROLES.map((r) => (
                                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="password">Heslo *</Label>
                        <Input
                            id="password" name="password" type="password" required
                            value={password} onChange={(e) => setPassword(e.target.value)}
                        />
                        <ul className="mt-1.5 space-y-0.5">
                            {PASSWORD_CHECKS.map((c) => (
                                <li key={c.label} className={`text-xs ${c.test(password) ? "text-emerald-600" : "text-muted-foreground"}`}>
                                    {c.test(password) ? "✓" : "○"} {c.label}
                                </li>
                            ))}
                        </ul>
                    </div>

                    {error && <p className="text-sm text-destructive">{error}</p>}

                    <div className="flex gap-2 pt-1">
                        <Button type="submit" disabled={!checksOk || pending}>
                            {pending ? "Vytváram…" : "Vytvoriť používateľa"}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => router.back()}>
                            Zrušiť
                        </Button>
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
