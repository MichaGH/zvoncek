import type { Lead } from "@/app/generated/prisma/client";
import type { Tx } from "@/lib/access/locks";
import { bump, isLeadBumped, markLeadBumped } from "@/lib/domain/revision";

// Najnižšia vrstva zápisu Lead stĺpcov – samostatne, aby ju mohli používať dealMutations aj taskMutations
// bez vzájomného importu. Revízia sa zvýši len pri prvom zápise v transakcii.

export async function updateLead(tx: Tx, leadId: string, data: Parameters<Tx["lead"]["update"]>[0]["data"]) {
    const updated = await tx.lead.update({
        where: { id: leadId },
        data: { ...data, ...(isLeadBumped(tx, leadId) ? {} : bump) },
    });
    markLeadBumped(tx, leadId);
    return updated;
}

export function hadNextAction(lead: Pick<Lead, "nextActionKind" | "nextActionAt" | "nextActionNote">) {
    return Boolean(lead.nextActionKind || lead.nextActionAt || lead.nextActionNote);
}
