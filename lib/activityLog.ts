import type {
    ActivitySource,
    ActivityType,
    CallOutcome,
    NextActionKind,
    NextActionMode,
} from "@/app/generated/prisma/enums";
import { formatBusinessDateTime } from "@/lib/domain/businessTime";

type ActivityPayload = {
    leadId: string;
    userId: string;
    type: ActivityType;
    category: "BUSINESS" | "PLANNING" | "AUDIT";
    source: ActivitySource;
    outcome?: CallOutcome | null;
    note?: string | null;
    createdAt?: Date;
};

export function createBusinessActivity(
    data: Omit<ActivityPayload, "category">,
): ActivityPayload {
    return { ...data, category: "BUSINESS" };
}

export function createPlanningActivity(
    data: Omit<ActivityPayload, "category" | "type"> & {
        type: "NEXT_ACTION_SET" | "NEXT_ACTION_CHANGED" | "NEXT_ACTION_CLEARED";
    },
): ActivityPayload {
    return { ...data, category: "PLANNING" };
}

export function createAuditActivity(
    data: Omit<ActivityPayload, "category">,
): ActivityPayload {
    return { ...data, category: "AUDIT" };
}

export type NextActionData = {
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    nextActionNote: string | null;
};

export function nextActionData(
    kind: NextActionKind | null,
    at?: Date | null,
    note?: string | null,
    hasTime: boolean = false,
    mode: NextActionMode = "SCHEDULED",
): NextActionData {
    return {
        nextActionKind: kind,
        nextActionAt: at ?? null,
        nextActionHasTime: hasTime,
        nextActionMode: mode,
        nextActionNote: note?.trim() || null,
    };
}

export function describeNextAction(
    data: Omit<NextActionData, "nextActionHasTime" | "nextActionMode"> & { nextActionHasTime?: boolean },
): string {
    if (!data.nextActionKind) return "Ďalší krok bol vymazaný";

    const parts: string[] = [data.nextActionKind];
    // Dátum v obchodnej zóne – server beží v UTC. Deň-only bez času.
    if (data.nextActionAt) parts.push(formatBusinessDateTime(data.nextActionAt, data.nextActionHasTime ?? true));
    if (data.nextActionNote) parts.push(data.nextActionNote);
    return parts.join(" · ");
}
