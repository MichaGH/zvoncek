"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { setUserTeam } from "@/lib/actions/teams";
import type { TeamOption } from "@/lib/queries/teams";
import { Users } from "lucide-react";

type Props = {
    userId: string;
    teamId: string | null;
    leadsTeam: { id: string; name: string } | null;
    teamOptions: TeamOption[];
};

export default function TeamAssignmentCard({ userId, teamId, leadsTeam, teamOptions }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    function handleChange(value: string) {
        startTransition(async () => {
            await setUserTeam(userId, value || null);
            router.refresh();
        });
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
                <Users className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Tím</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
                {leadsTeam && (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Vedie tím</span>
                        <Link href="/dashboard/admin/teams" className="hover:underline">
                            <Badge>{leadsTeam.name}</Badge>
                        </Link>
                    </div>
                )}

                <div className="space-y-1.5">
                    <label htmlFor="teamId" className="text-muted-foreground">
                        Členstvo v tíme
                    </label>
                    <select
                        id="teamId"
                        value={teamId ?? ""}
                        onChange={(e) => handleChange(e.target.value)}
                        disabled={pending}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                        <option value="">— žiadny —</option>
                        {teamOptions.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.name}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                        Vedúceho tímu priradíš v sekcii{" "}
                        <Link href="/dashboard/admin/teams" className="underline">
                            Tímy
                        </Link>
                        .
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
