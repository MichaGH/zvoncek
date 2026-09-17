"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PipelineUserOption } from "@/lib/queries/pipeline";

// Filter „Rieši": všetci / ja / nepriradené / konkrétny človek. Rozsah vynucuje server (manažér vidí všetko).
export default function PipelineOwnerSelect({ owner, users }: { owner: string; users: PipelineUserOption[] }) {
    const router = useRouter();
    const params = useSearchParams();

    function change(value: string) {
        const next = new URLSearchParams(params.toString());
        if (value === "all") next.delete("owner");
        else next.set("owner", value);
        next.delete("limit");
        router.push(`/dashboard/pipeline?${next.toString()}`);
    }

    return (
        <Select value={owner} onValueChange={change}>
            <SelectTrigger size="sm" className="h-10 w-auto min-w-40 gap-1.5">
                <span className="text-muted-foreground">Rieši:</span>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">všetci</SelectItem>
                <SelectItem value="me">ja</SelectItem>
                <SelectItem value="unassigned">nepriradené</SelectItem>
                {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                        {u.firstName} {u.lastName}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
