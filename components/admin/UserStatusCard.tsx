"use client";

import { useTransition } from "react";
import { UserX, UserCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { adminDeactivateUser, adminReactivateUser } from "@/lib/actions/admin";

type Props = {
    userId: string;
    deletedAt: Date | null;
    isSelf: boolean;
};

function formatDate(d: Date) {
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "long", year: "numeric" });
}

export default function UserStatusCard({ userId, deletedAt, isSelf }: Props) {
    const [pending, startTransition] = useTransition();
    const isDeactivated = !!deletedAt;

    function handleDeactivate() {
        if (!window.confirm("Naozaj chceš deaktivovať tento účet? Používateľ sa nebude môcť prihlásiť.")) return;
        startTransition(async () => { await adminDeactivateUser(userId); });
    }

    function handleReactivate() {
        startTransition(async () => { await adminReactivateUser(userId); });
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
            </CardContent>
        </Card>
    );
}
