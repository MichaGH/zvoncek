"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminResetPassword } from "@/lib/actions/admin";

const CHECKS = [
    { label: "Aspoň 8 znakov", test: (p: string) => p.length >= 8 },
    { label: "Veľké písmeno", test: (p: string) => /[A-Z]/.test(p) },
    { label: "Číslo", test: (p: string) => /[0-9]/.test(p) },
];

export default function UserPasswordCard({ userId }: { userId: string }) {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [pending, startTransition] = useTransition();

    const checksOk = CHECKS.every((c) => c.test(password));
    const formOk = checksOk && password === confirm;

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setSuccess(false);
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
            const result = await adminResetPassword(userId, fd);
            if (!result.ok) { setError(result.error); return; }
            setError(null);
            setSuccess(true);
            setPassword("");
            setConfirm("");
        });
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Zmena hesla</CardTitle>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="password">Nové heslo</Label>
                        <Input
                            id="password" name="password" type="password"
                            value={password} onChange={(e) => { setPassword(e.target.value); setSuccess(false); }}
                            required
                        />
                        <ul className="mt-1.5 space-y-0.5">
                            {CHECKS.map((c) => (
                                <li key={c.label} className={`text-xs ${c.test(password) ? "text-emerald-600" : "text-muted-foreground"}`}>
                                    {c.test(password) ? "✓" : "○"} {c.label}
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="confirm">Potvrdiť heslo</Label>
                        <Input
                            id="confirm" name="confirm" type="password"
                            value={confirm} onChange={(e) => { setConfirm(e.target.value); setSuccess(false); }}
                            required
                        />
                        {confirm && password !== confirm && (
                            <p className="text-xs text-destructive">Heslá sa nezhodujú.</p>
                        )}
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    {success && <p className="text-sm text-emerald-600">Heslo bolo zmenené.</p>}
                    <Button type="submit" size="sm" disabled={!formOk || pending}>
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                        {pending ? "Ukladám…" : "Nastaviť heslo"}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
