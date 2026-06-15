"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Pencil, Trash2 } from "lucide-react";
import { deleteContact, updateContact } from "@/lib/actions/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";

export type EditableContact = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    note: string | null;
};

export default function ContactRowActions({
    contact,
    locked,
}: {
    contact: EditableContact;
    locked?: boolean;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [pending, startTransition] = useTransition();

    const [companyName, setCompanyName] = useState(contact.companyName ?? "");
    const [website, setWebsite] = useState(contact.website ?? "");
    const [phone, setPhone] = useState(contact.phone ?? "");
    const [note, setNote] = useState(contact.note ?? "");
    const [error, setError] = useState<string | null>(null);

    function save() {
        setError(null);
        startTransition(async () => {
            const result = await updateContact(contact.id, { companyName, website, phone, note });
            if (!result.ok) {
                setError(result.error);
                return;
            }
            toast.success("Uložené");
            setOpen(false);
            router.refresh();
        });
    }

    function remove() {
        const label = contact.companyName ?? contact.website ?? `#${contact.number}`;
        if (!window.confirm(`Vymazať kontakt ${label}?`)) return;
        startTransition(async () => {
            const result = await deleteContact(contact.id);
            if (!result.ok) {
                toast.error(result.error);
                return;
            }
            toast.success("Kontakt vymazaný");
            router.refresh();
        });
    }

    // Obvolaný kontakt (alebo nie tvoj) → zámok, žiadne úpravy.
    if (locked) {
        return (
            <span
                className="flex items-center justify-center gap-1 text-xs text-muted-foreground"
                title="Kontakt je už obvolaný – nedá sa upraviť ani vymazať"
            >
                <Lock className="h-3.5 w-3.5" /> obvolaný
            </span>
        );
    }

    return (
        <div className="flex items-center justify-center gap-1">
            <Button
                variant="ghost"
                size="icon"
                aria-label="Upraviť kontakt"
                onClick={() => setOpen(true)}
            >
                <Pencil className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                aria-label="Vymazať kontakt"
                onClick={remove}
                disabled={pending}
                className="text-muted-foreground hover:text-destructive"
            >
                <Trash2 className="h-4 w-4" />
            </Button>

            <Drawer open={open} onOpenChange={setOpen} direction="right">
                <DrawerContent>
                    <DrawerHeader>
                        <DrawerTitle>Upraviť kontakt #{contact.number}</DrawerTitle>
                    </DrawerHeader>

                    <div className="space-y-4 overflow-y-auto px-4">
                        <div className="grid gap-1.5">
                            <Label htmlFor="edit-company">Firma</Label>
                            <Input
                                id="edit-company"
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                placeholder="Autoservis Kováč"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="edit-website">Web</Label>
                            <Input
                                id="edit-website"
                                value={website}
                                onChange={(e) => setWebsite(e.target.value)}
                                placeholder="kovac.sk"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="edit-phone">Telefón</Label>
                            <Input
                                id="edit-phone"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                placeholder="0905 123 456"
                                inputMode="tel"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="edit-note">Poznámka</Label>
                            <Input
                                id="edit-note"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="stará stránka, len vizitka…"
                            />
                        </div>

                        {error && <p className="text-sm text-destructive">{error}</p>}
                    </div>

                    <DrawerFooter>
                        <Button onClick={save} disabled={pending}>
                            {pending ? "Ukladám…" : "Uložiť"}
                        </Button>
                        <DrawerClose asChild>
                            <Button variant="outline" disabled={pending}>
                                Zrušiť
                            </Button>
                        </DrawerClose>
                    </DrawerFooter>
                </DrawerContent>
            </Drawer>
        </div>
    );
}
