"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserX, UserCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { adminDeactivateUser, adminReactivateUser } from "@/lib/actions/admin";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";

type Props = {
    userId: string;
    deletedAt: Date | null;
    isSelf: boolean;
    work: { retries: number; scheduled: number; snoozed: number; deals: number };
};

function formatDate(d: Date) {
    return d.toLocaleDateString("sk-SK", { timeZone: BUSINESS_TZ, day: "numeric", month: "long", year: "numeric" });
}

export default function UserStatusCard({ userId, deletedAt, isSelf, work }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const isDeactivated = !!deletedAt;
    const hasWork = work.retries + work.scheduled + work.snoozed + work.deals > 0;

    function handleDeactivate() {
        if (!window.confirm("Naozaj chceš deaktivovať tento účet? Používateľ sa nebude môcť prihlásiť a jeho nevolané nové kontakty sa vrátia do fronty.")) return;
        startTransition(async () => {
            const r = await adminDeactivateUser(userId);
            if (!r.ok) toast.error(r.error);
            else toast.success(`Deaktivovaný · do fronty vrátených nových kontaktov: ${r.data?.released ?? 0}`);
            router.refresh();
        });
    }

    function handleReactivate() {
        startTransition(async () => {
            const r = await adminReactivateUser(userId);
            if (!r.ok) toast.error(r.error);
            router.refresh();
        });
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Stav účtu</CardTitle>
                <Badge variant={isDeactivated ? "destructive" : "secondary"}>
                    {isDeactivated ? "Deaktivovaný" : "Aktívny"}
                </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
                {isDeactivated ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            Deaktivovaný {formatDate(deletedAt!)}. Používateľ sa nemôže prihlásiť.
                        </p>
                        <Button size="sm" variant="outline" disabled={pending} onClick={handleReactivate}>
                            <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                            {pending ? "Reaktivujem…" : "Reaktivovať účet"}
                        </Button>
                    </>
                ) : (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {isSelf
                                ? "Nemôžeš deaktivovať vlastný účet."
                                : "Deaktivácia zablokuje prihlasovanie. Dáta zostanú zachované."}
                        </p>
                        <Button
                            size="sm" variant="destructive" disabled={pending || isSelf}
                            onClick={handleDeactivate}
                        >
                            <UserX className="mr-1.5 h-3.5 w-3.5" />
                            {pending ? "Deaktivácia…" : "Deaktivovať účet"}
                        </Button>
                    </>
                )}
                {hasWork && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                        <p>
                            Má {work.retries} retry, {work.scheduled} dohodnutých, {work.snoozed} spiacich a {work.deals} otvorených
                            obchodov{isDeactivated ? " – presuň ich" : ""}.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {work.retries + work.scheduled + work.snoozed > 0 && (
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/dashboard/calls/assignments">Priradenia volaní</Link>
                                </Button>
                            )}
                            {work.deals > 0 && (
                                <Button asChild size="sm" variant="outline">
                                    <Link href={`/dashboard/pipeline?filter=all&owner=${userId}`}>Obchody (Presunúť obchody)</Link>
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
