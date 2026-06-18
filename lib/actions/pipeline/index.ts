"use server";

import { auth } from "@/auth";
import { ActivityType, LeadStatus, NextActionKind, NextActionMode, ProjectType } from "@/app/generated/prisma/enums";
import {
    createAuditActivity,
    createBusinessActivity,
    createPlanningActivity,
    describeNextAction,
    nextActionData,
} from "@/lib/activityLog";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import { revalidatePath } from "next/cache";

function revalidatePipeline(leadId: string) {
    revalidatePath("/dashboard/pipeline");
    revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/calls");
}

const FIELD_LABELS: Record<string, string> = {
    companyName: "Firma",
    website: "Web",
    phone: "Telefón",
    email: "Email",
    note: "Poznámka",
    price: "Cena",
    priceNote: "Rozpis ceny",
};

function fmtVal(key: string, v: unknown): string {
    if (v == null || v === "") return "—";
    if (key === "price") return `${Number(v)} €`;
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

// Build a human "what changed" note: "Telefón: 0900 → 0901 · Email: a → b".
function diffNote(
    current: Record<string, unknown>,
    data: Record<string, unknown>,
): string | null {
    const parts: string[] = [];
    for (const key of Object.keys(data)) {
        const oldV = current[key] ?? null;
        const newV = data[key] ?? null;
        const oldKey = oldV == null ? "" : key === "price" ? String(Number(oldV)) : String(oldV);
        const newKey = newV == null ? "" : String(newV);
        if (oldKey !== newKey) {
            parts.push(`${FIELD_LABELS[key] ?? key}: ${fmtVal(key, oldV)} → ${fmtVal(key, newV)}`);
        }
    }
    return parts.length ? parts.join(" · ") : null;
}

export async function updateLead(
    leadId: string,
    data: {
        companyName?: string | null;
        website?: string | null;
        phone?: string | null;
        email?: string | null;
        note?: string | null;
    },
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: {
                    companyName: true,
                    website: true,
                    phone: true,
                    email: true,
                    note: true,
                },
            });
            if (!current) throw new Error("not found");

            const note = diffNote(
                current as Record<string, unknown>,
                data as Record<string, unknown>,
            );
            await tx.lead.update({ where: { id: leadId }, data });
            if (note) {
                await tx.activity.create({
                    data: createAuditActivity({
                        leadId,
                        userId,
                        type: "CONTACT_UPDATED",
                        source: "PIPELINE",
                        note,
                    }),
                });
            }
        });
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

// Cena aj poznámka sa ukladajú nezávisle – poznámka sa dá uložiť aj BEZ ceny
// (interná „nastrelená" cena pre marketing). Odoslanie klientovi je samostatný
// revertovateľný prepínač (setQuoteSent). Zmena ceny sa loguje ako diff.
export async function saveQuote(
    leadId: string,
    input: { price: number | null; priceNote: string | null },
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    const price = input.price;
    const priceNote = input.priceNote?.trim() || null;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { price: true },
            });
            if (!current) throw new Error("not found");
            const oldPrice = current.price != null ? Number(current.price) : null;

            await tx.lead.update({ where: { id: leadId }, data: { price, priceNote } });
            if (oldPrice !== price) {
                const fmt = (p: number | null) => (p != null ? `${p} €` : "—");
                await tx.activity.create({
                    data: createAuditActivity({
                        leadId,
                        userId,
                        type: "CONTACT_UPDATED",
                        source: "PIPELINE",
                        note: `Cena: ${fmt(oldPrice)} → ${fmt(price)}`,
                    }),
                });
            }
        });
    } catch {
        return { error: "Nepodarilo sa uložiť cenovú ponuku." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

// Označiť cenovú ponuku (email) ako odoslanú. Automaticky nastaví priceDisclosed=true
// a naplánuje follow-up hovor o týždeň. Revertovateľné (sent=false).
export async function setQuoteSent(leadId: string, sent: boolean) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: {
                    price: true,
                    nextActionKind: true,
                    nextActionAt: true,
                    nextActionNote: true,
                },
            });
            if (!current) throw new Error("not found");

            if (sent) {
                const at = new Date();
                const followUpAt = new Date(at);
                followUpAt.setDate(followUpAt.getDate() + 7);
                const next = nextActionData("CALL", followUpAt, "Zavolať, či cenová ponuka prišla");
                const hadNext = Boolean(
                    current.nextActionKind || current.nextActionAt || current.nextActionNote,
                );
                const p = current.price != null ? Number(current.price) : null;

                await tx.lead.update({
                    where: { id: leadId },
                    data: { quoteSentAt: at, priceDisclosed: true, ...next },
                });
                await tx.activity.create({
                    data: createBusinessActivity({
                        leadId,
                        userId,
                        type: "QUOTE_SENT",
                        source: "PIPELINE",
                        note: p != null ? `Cenová ponuka odoslaná: ${p} €` : "Cenová ponuka odoslaná",
                        createdAt: at,
                    }),
                });
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId,
                        userId,
                        type: hadNext ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                        source: "PIPELINE",
                        note: describeNextAction(next),
                    }),
                });
            } else {
                await tx.lead.update({ where: { id: leadId }, data: { quoteSentAt: null } });
                await tx.activity.create({
                    data: createAuditActivity({
                        leadId,
                        userId,
                        type: "CONTACT_UPDATED",
                        source: "PIPELINE",
                        note: "Odoslanie cenovej ponuky zrušené",
                    }),
                });
            }
        });
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

// Checkbox „klient pozná cenu" – nezávislý od CP emailu (napr. povedaná cena ústne,
// alebo cena bola v dizajnovom návrhu). Loguje len AUDIT aktivitu, neprepisuje
// posledný obchodný krok.
export async function setPriceDisclosed(leadId: string, disclosed: boolean) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { priceDisclosed: disclosed } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "CONTACT_UPDATED",
                    source: "PIPELINE",
                    note: disclosed ? "Klient oboznámený s cenou" : "Oboznámenie s cenou zrušené",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function setProjectType(leadId: string, projectType: ProjectType | null) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    try {
        await prisma.lead.update({ where: { id: leadId }, data: { projectType } });
    } catch {
        return { error: "Nepodarilo sa uložiť typ projektu." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function changeStatus(leadId: string, status: LeadStatus) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { status } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "STATUS_CHANGED",
                    source: "PIPELINE",
                    note: `Stav zmenený na ${status}`,
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa zmeniť stav." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function changeOwner(leadId: string, ownerId: string | null) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { ownerId } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "OWNER_CHANGED",
                    source: "PIPELINE",
                    note: ownerId ? "Vlastník príležitosti bol zmenený" : "Vlastník príležitosti bol odobratý",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa zmeniť vlastníka." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function setNextAction(
    leadId: string,
    kind: NextActionKind | null,
    at: string | null,
    note: string | null,
    hasTime: boolean = false,
    mode: NextActionMode = "SCHEDULED",
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
            });
            if (!current) throw new Error("Lead not found");

            const next = nextActionData(kind, at ? new Date(at) : null, note, hasTime, mode);
            const hadNextAction = Boolean(
                current.nextActionKind || current.nextActionAt || current.nextActionNote,
            );
            const type = !kind
                ? "NEXT_ACTION_CLEARED"
                : hadNextAction
                  ? "NEXT_ACTION_CHANGED"
                  : "NEXT_ACTION_SET";

            await tx.lead.update({ where: { id: leadId }, data: next });
            await tx.activity.create({
                data: createPlanningActivity({
                    leadId,
                    userId,
                    type,
                    source: "PIPELINE",
                    note: describeNextAction(next),
                }),
            });
        });
    } catch {
        return { error: "Nepodarilo sa nastaviť ďalší krok." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

const SENT_DEFAULTS: Record<
    "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT",
    { dateField: "quoteSentAt" | "designSentAt" | "aboutUsSentAt"; note: string }
> = {
    QUOTE_SENT: {
        dateField: "quoteSentAt",
        note: "Zavolať, či cenová ponuka prišla",
    },
    DESIGN_SENT: {
        dateField: "designSentAt",
        note: "Zavolať, či si návrh pozreli",
    },
    EMAIL_SENT: {
        dateField: "aboutUsSentAt",
        note: "Zavolať, či email prišiel / či si ho pozreli",
    },
};

export async function logSent(
    leadId: string,
    what: "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT",
    sentAt?: string,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    const at = sentAt ? new Date(sentAt) : new Date();
    const followUpAt = new Date(at);
    followUpAt.setDate(followUpAt.getDate() + 7);
    const defaults = SENT_DEFAULTS[what];
    const next = nextActionData("CALL", followUpAt, defaults.note);

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
            });
            if (!current) throw new Error("Lead not found");
            const hadNextAction = Boolean(
                current.nextActionKind || current.nextActionAt || current.nextActionNote,
            );

            await tx.lead.update({
                where: { id: leadId },
                data: { [defaults.dateField]: at, ...next },
            });
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId,
                    userId,
                    type: what,
                    source: "PIPELINE",
                    createdAt: at,
                }),
            });
            await tx.activity.create({
                data: createPlanningActivity({
                    leadId,
                    userId,
                    type: hadNextAction ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                    source: "PIPELINE",
                    note: describeNextAction(next),
                }),
            });
        });
    } catch {
        return { error: "Nepodarilo sa zapísať." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function markLost(leadId: string, reason: string | null) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
            });
            if (!current) throw new Error("not found");
            const hadNext = Boolean(current.nextActionKind || current.nextActionAt || current.nextActionNote);

            await tx.lead.update({
                where: { id: leadId },
                data: {
                    status: "LOST",
                    lostReason: reason?.trim() || null,
                    nextActionKind: null,
                    nextActionAt: null,
                    nextActionNote: null,
                    nextActionHasTime: false,
                },
            });
            await tx.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "STATUS_CHANGED",
                    source: "PIPELINE",
                    note: reason?.trim() ? `Stratená: ${reason.trim()}` : "Označené ako stratené",
                }),
            });
            if (hadNext) {
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId,
                        userId,
                        type: "NEXT_ACTION_CLEARED",
                        source: "PIPELINE",
                        note: "Ďalší krok zmazaný (príležitosť stratená)",
                    }),
                });
            }
        });
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function addBusinessNote(leadId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
    if (!note.trim()) return { error: "Poznámka nemôže byť prázdna." };

    try {
        await prisma.activity.create({
            data: createBusinessActivity({
                leadId,
                userId: session.user.id,
                type: "NOTE",
                source: "PIPELINE",
                note: note.trim(),
            }),
        });
    } catch {
        return { error: "Nepodarilo sa pridať poznámku." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function logBusinessActivity(
    leadId: string,
    type: Extract<ActivityType, "SMS_SENT">,
    note?: string,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };

    try {
        await prisma.activity.create({
            data: createBusinessActivity({
                leadId,
                userId: session.user.id,
                type,
                source: "PIPELINE",
                note: note?.trim() || null,
            }),
        });
    } catch {
        return { error: "Nepodarilo sa zapísať aktivitu." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}
