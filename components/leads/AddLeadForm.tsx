"use client";

import { useRef, useState } from "react";
import { createLead } from "@/lib/actions/leads";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

export default function AddLeadForm() {
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [note, setNote] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastAdded, setLastAdded] = useState<{ name: string; number: number }[]>([]);
    const nameRef = useRef<HTMLInputElement>(null);

    async function submit() {
        if (pending) return;
        setError(null);

        // jedno pole pre meno/web – ak to vyzerá ako doména, je to web
        const value = name.trim();
        const isWebsite = /\.[a-z]{2,}$/i.test(value) && !value.includes(" ");

        setPending(true);
        const result = await createLead({
            companyName: isWebsite ? undefined : value,
            website: isWebsite ? value : undefined,
            phone,
            note,
        });
        setPending(false);

        if (result.error) {
            setError(result.error);
            return;
        }

        // úspech: vyčisti, fokus späť, zapíš do "práve pridané"
        setLastAdded((prev) => [{ name: value, number: result.number! }, ...prev].slice(0, 8));
        setName("");
        setPhone("");
        setNote("");
        nameRef.current?.focus();
    }

    return (
        <div className="space-y-4">
            <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); submit(); }}
            >
                <div className="grid gap-1.5">
                    <Label htmlFor="name">Firma alebo web</Label>
                    <Input
                        ref={nameRef}
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Autoservis Kováč / kovac.sk"
                        autoFocus
                        autoComplete="off"
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="phone">Telefón</Label>
                    <Input
                        id="phone"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="0905 123 456"
                        autoComplete="off"
                        inputMode="tel"
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="note" className="text-muted-foreground">Poznámka (nepovinné)</Label>
                    <Input
                        id="note"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="stará stránka, len vizitka…"
                        autoComplete="off"
                    />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button type="submit" className="w-full" disabled={pending || !phone.trim() || !name.trim()}>
                    {pending ? "Pridávam…" : "Pridať (Enter)"}
                </Button>
            </form>

            {/* práve pridané – potvrdenie, že sa to deje */}
            {lastAdded.length > 0 && (
                <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Práve pridané</p>
                    <div className="space-y-1">
                        {lastAdded.map((l) => (
                            <div key={l.number} className="flex items-center gap-2 text-sm">
                                <Check className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">#{l.number}</span>
                                <span className="truncate">{l.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}