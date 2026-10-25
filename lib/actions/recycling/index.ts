"use server";

import { revalidatePath } from "next/cache";
import { FORBIDDEN, UNAUTHENTICATED, type ActionError } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import { recycleLeadsAs, type RecycleResult } from "@/lib/commands/recycling";
import { parseRecycleParams, recycleSelection, type RecycleInput, type RecycleSelection } from "@/lib/domain/recycling";
import { can } from "@/lib/permissions";
import { getRecycleFirst } from "@/lib/queries/recycling";

export async function recycleLeads(input: RecycleInput): Promise<RecycleResult> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await recycleLeadsAs(user, input);
    // Aj chyba po čiastočnom priebehu mohla niečo recyklovať – obnovíme vždy.
    revalidatePath("/dashboard/admin/recycle");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/pipeline");
    revalidatePath("/dashboard/contacts");
    revalidatePath("/dashboard");
    return result;
}

// „Vybrať prvých N" – filtre prídu ako surový query string a prejdú tým istým parserom ako stránka.
export async function pickRecycleFirst(
    query: Record<string, string>,
    n: number,
): Promise<{ items: (RecycleSelection & { leadId: string })[] } | ActionError> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    if (!can(user, "contacts.recycle")) return FORBIDDEN;
    if (!Number.isFinite(n) || n < 1) return { error: "Zadaj počet." };
    const rows = await getRecycleFirst(parseRecycleParams(query ?? {}), n);
    return { items: rows.map((r) => ({ leadId: r.id, ...recycleSelection(r) })) };
}
