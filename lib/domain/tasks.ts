import { z } from "zod";
import type { DealTaskContent, DealTaskStatus, DealTaskType, NextActionKind } from "@/app/generated/prisma/enums";
import { formatMoney, type OfferContent } from "@/lib/domain/offers";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind } from "@/lib/domain/leadFlow";

// Úlohy pre manažéra (wave 3 – context/features/01-salesrep/wave-3-task-proposal-final.md).
// Čisté pravidlá bez DB: dá sa importovať aj z klientskych komponentov. Zápisy sú v lib/domain/taskMutations.ts.
//
// Úloha = obchodník žiada manažéra o cenu / návrh / iné (HELP) alebo o prevzatie klienta (HANDOVER).
// Zámok = obchod má OPEN úlohu → ďalší krok je zamknutý (odvodené, nič sa neukladá). SQL dvojča zámku je
// STEP_LOCKED_SQL v lib/queries/pipeline (paritný test v check-concurrency.ts).

export const TASK_CONTENTS = ["PRICE", "DESIGN", "OTHER"] as const satisfies readonly DealTaskContent[];
export const TASK_TYPES = ["HELP", "HANDOVER"] as const satisfies readonly DealTaskType[];

export const TASK_TEXT_MAX = 2000;
export const TASK_REASON_MAX = 500;

// ── Zámok ────────────────────────────────────────────────────────────────────

export function isStepLocked(tasks: readonly { status: DealTaskStatus }[]): boolean {
    return tasks.some((t) => t.status === "OPEN");
}

// ── Krok po vybavení (D3, spätná väzba 2026-09-19) ──────────────────────────
// Krok sa pri žiadosti NEVYBERÁ – obchodník žiada manažéra práve preto, aby mohol urobiť svoj krok:
//   cena → „Poslať cenu", návrh → „Poslať návrh" (pevné; cena / návrh sa musia poslať alebo výslovne odmietnuť),
//   iné → ostáva aktuálny krok (dá sa zmeniť na ľubovoľný).
// Čakajúce staršie výsledky (I10) krok ešte zúžia: čaká návrh → „Poslať návrh".
// Poznámka ku kroku ostáva, keď sa druh nemení; inak predvolená poznámka druhu.
//
// [WAVE 4] (context/features/01-salesrep/wave-4-proposal.md §2): úloha bude niesť cenu AJ návrh naraz (výber
// v components/pipeline/AskManagerDialog.tsx), krok „Poslať návrh + cenu", čiastočné vybavenie (cena hotová, návrh
// ešte nie). Dovtedy je obsah úlohy jedna voľba; pri viacerých obsahoch návrh vyhráva (návrh nesie aj cenu).
// [WAVE 5] Celý výber cena / návrh / email sa prerobí (čo klient chcel vs. čo sme poslali) – samostatná feature.

export type StepAfterTask = { kind: FollowUpNextKind; note: string | null; fixed: boolean };

export function stepAfterTask(
    contents: readonly DealTaskContent[],
    current: { kind: NextActionKind | null; note: string | null },
    pending: readonly { kind: ItemKind }[],
    defaultNote: (kind: NextActionKind) => string | null,
): StepAfterTask {
    const fixed = contents.includes("DESIGN") || contents.includes("PRICE");
    let kind: FollowUpNextKind = contents.includes("DESIGN")
        ? "SEND_DESIGN"
        : contents.includes("PRICE")
          ? "SEND_QUOTE"
          : (current.kind ?? "CALL");
    const required = requiredStepKinds(pending);
    if (required && !required.includes(kind)) kind = required[0] as FollowUpNextKind;
    return { kind, note: kind === current.kind ? (current.note ?? null) : defaultNote(kind), fixed };
}

// Pri úlohe „Iné" sa krok dá zmeniť – na čo (I10 ho pri čakajúcich výsledkoch zúži).
export function choosableStepKinds(pending: readonly { kind: ItemKind }[]): FollowUpNextKind[] {
    const required = requiredStepKinds(pending);
    return FOLLOW_UP_NEXT_KINDS.filter((k) => !required || required.includes(k));
}

// ── Výsledok úlohy ───────────────────────────────────────────────────────────

const moneyString = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

export const taskDesignSnapshot = z
    .object({ id: z.string().min(1), label: z.string().nullable(), url: z.string().min(1), version: z.number().int().min(1) })
    .strict();

// Nemenný záznam toho, čo manažér dodal (aktuálna cena / návrh sa neskôr môžu zmeniť).
export const taskResultSchema = z
    .object({
        price: z.object({ amount: moneyString, note: z.string().nullable() }).strict().optional(),
        designs: z.array(taskDesignSnapshot).min(1).max(10).optional(),
        answer: z.string().min(1).max(5000).optional(),
    })
    .strict();

export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskDesignSnapshot = z.infer<typeof taskDesignSnapshot>;

export function parseTaskResult(value: unknown): TaskResult | null {
    const parsed = taskResultSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

// ── Vrátené položky (§6.13) ─────────────────────────────────────────────────
// PRICE jedna na úlohu, DESIGN jedna na (úlohu, návrh), OTHER (odpoveď) a DECLINED (dôvod zamietnutia) jedna na úlohu.
// Položku spotrebuje len odoslanie, ktoré ju menuje v OFFER_SENT.meta.fulfils, alebo TASK_RESULT_DISMISSED s meta.items.

export const ITEM_KINDS = ["PRICE", "DESIGN", "OTHER", "DECLINED"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemRef = { taskId: string; kind: ItemKind; designId?: string };

export function itemKey(item: ItemRef): string {
    return `${item.taskId}:${item.kind}:${item.kind === "DESIGN" ? (item.designId ?? "") : ""}`;
}

const designIdRule = (i: { kind: string; designId?: string }) => (i.kind === "DESIGN" ? Boolean(i.designId) : i.designId === undefined);

// Čo odoslanie použilo (OFFER_SENT.meta.fulfils) – len cena a návrh sa posielajú.
export const fulfilsSchema = z
    .array(
        z
            .object({ taskId: z.string().min(1), kind: z.enum(["PRICE", "DESIGN"]), designId: z.string().min(1).optional() })
            .strict()
            .refine(designIdRule, "DESIGN potrebuje designId, iné nie"),
    )
    .max(20);
export type Fulfils = z.infer<typeof fulfilsSchema>;

// Čo sa neposiela / berie na vedomie (TASK_RESULT_DISMISSED.meta.items – jeden riadok na úlohu, taskId je na riadku).
export const dismissItemSchema = z
    .object({ taskId: z.string().min(1), kind: z.enum(ITEM_KINDS), designId: z.string().min(1).optional() })
    .strict()
    .refine(designIdRule, "DESIGN potrebuje designId, iné nie");
export const dismissInputSchema = z
    .object({ items: z.array(dismissItemSchema).min(1).max(20), reason: z.string().max(TASK_REASON_MAX).nullish() })
    .strict();
export type DismissInput = z.infer<typeof dismissInputSchema>;

// Neposielanú cenu / návrh treba zdôvodniť; odpoveď a zamietnutie sa len berie na vedomie.
export function dismissNeedsReason(items: readonly { kind: ItemKind }[]): boolean {
    return items.some((i) => i.kind === "PRICE" || i.kind === "DESIGN");
}

export const ACKNOWLEDGED_TEXT = "Beriem na vedomie";

const dismissalMetaSchema = z.object({
    items: z.array(z.object({ kind: z.enum(ITEM_KINDS), designId: z.string().optional() })),
});
const fulfilsMetaSchema = z.object({ fulfils: fulfilsSchema });

export function dismissedItemsOfMeta(taskId: string | null, meta: unknown): ItemRef[] {
    const parsed = dismissalMetaSchema.safeParse(meta);
    if (!taskId || !parsed.success) return [];
    return parsed.data.items.map((i) => ({ taskId, kind: i.kind, ...(i.kind === "DESIGN" && i.designId ? { designId: i.designId } : {}) }));
}

export function fulfilsOfMeta(meta: unknown): ItemRef[] {
    const parsed = fulfilsMetaSchema.safeParse(meta);
    if (!parsed.success) return [];
    return parsed.data.fulfils.map((f) => ({ taskId: f.taskId, kind: f.kind, ...(f.designId ? { designId: f.designId } : {}) }));
}

export type ClosedTaskInput = {
    id: string;
    type: DealTaskType;
    status: DealTaskStatus;
    result: unknown;
    closeReason: string | null;
    closedAt: Date | null;
    closedBy: { id: string; firstName: string } | null;
};

export type PendingItem = ItemRef & {
    label: string; // „cena 1 285 €" / „návrh Variant A" / „odpoveď" / „zamietnuté"
    text: string | null; // odpoveď / dôvod zamietnutia
    price?: { amount: string; note: string | null };
    design?: TaskDesignSnapshot;
    by: { id: string; firstName: string } | null;
    closedAt: string | null;
};

// Všetky položky, ktoré úlohy vrátili (v poradí uzavretia), bez ohľadu na spotrebu.
export function returnedItems(tasks: readonly ClosedTaskInput[]): PendingItem[] {
    const sorted = [...tasks]
        // [WAVE 4] čiastočné vybavenie: aj OPEN úloha s čiastočným výsledkom (wave-4-proposal.md §2.4).
        .filter((t) => t.status === "DONE" || t.status === "DECLINED")
        .sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0) || (a.id < b.id ? -1 : 1));
    const out: PendingItem[] = [];
    for (const t of sorted) {
        const base = { taskId: t.id, by: t.closedBy, closedAt: t.closedAt?.toISOString() ?? null };
        if (t.status === "DECLINED") {
            out.push({ ...base, kind: "DECLINED", label: "zamietnuté", text: t.closeReason });
            continue;
        }
        if (t.type !== "HELP") continue; // prijaté odovzdanie nič nevracia
        const result = parseTaskResult(t.result);
        if (!result) continue;
        if (result.price) {
            out.push({ ...base, kind: "PRICE", label: `cena ${formatMoney(result.price.amount)}`, text: null, price: result.price });
        }
        for (const d of result.designs ?? []) {
            out.push({ ...base, kind: "DESIGN", designId: d.id, label: `návrh ${d.label ?? d.url}`, text: null, design: d });
        }
        if (result.answer) out.push({ ...base, kind: "OTHER", label: "odpoveď", text: result.answer });
    }
    return out;
}

// Nespotrebované položky: nič platné ich neposlalo (prečiarknuté odoslanie sa nepočíta) a nikto ich neodmietol.
export function pendingItems(
    tasks: readonly ClosedTaskInput[],
    consumed: { fulfils: readonly ItemRef[]; dismissed: readonly ItemRef[] },
): PendingItem[] {
    const used = new Set([...consumed.fulfils, ...consumed.dismissed].map(itemKey));
    return returnedItems(tasks).filter((i) => !used.has(itemKey(i)));
}

// I10: kým čaká vrátená cena / návrh, krok musí byť „Poslať návrh" (ak čaká návrh), inak „Poslať cenu" / „Poslať návrh".
// null = krok je voľný.
export function requiredStepKinds(pending: readonly { kind: ItemKind }[]): NextActionKind[] | null {
    if (pending.some((i) => i.kind === "DESIGN")) return ["SEND_DESIGN"];
    if (pending.some((i) => i.kind === "PRICE")) return ["SEND_QUOTE", "SEND_DESIGN"];
    return null;
}

// Dokončí toto odoslanie aktuálny krok (predvolí sa „Zavolať, či prišlo")? Áno, keď posiela obsah druhu kroku – alebo keď
// pri kroku „Poslať cenu / návrh" spotrebuje (pošle / odmietne) poslednú čakajúcu vrátenú cenu / návrh (R03-1: návrh
// išiel skôr, teraz posledná cena – krok „Poslať návrh" by inak ostal, hoci už nie je čo poslať).
export function sendCompletesStep(
    step: NextActionKind | null,
    sent: readonly OfferContent[],
    pendingBefore: readonly { kind: ItemKind }[],
    pendingAfter: readonly { kind: ItemKind }[],
): boolean {
    if (!step) return true;
    if (step === "SEND_QUOTE" && sent.includes("PRICE")) return true;
    if (step === "SEND_DESIGN" && sent.includes("DESIGN")) return true;
    if (step === "SEND_EMAIL" && (sent.includes("ABOUT_US") || sent.includes("PRICELIST"))) return true;
    return (step === "SEND_QUOTE" || step === "SEND_DESIGN") && requiredStepKinds(pendingBefore) !== null && requiredStepKinds(pendingAfter) === null;
}

// Riadok v zozname: „✓ cena 1 285 € (Michal) · ✓ návrh Variant A (Nikolas)"; jedno meno na konci, keď sú od toho istého.
export function pendingSummary(items: readonly PendingItem[]): string | null {
    if (items.length === 0) return null;
    const mark = (i: PendingItem) => (i.kind === "DECLINED" ? `✗ ${i.text ? `„${i.text}“` : "zamietnuté"}` : `✓ ${i.label}`);
    const names = [...new Set(items.map((i) => i.by?.firstName ?? "manažér"))];
    if (names.length === 1) return `${items.map(mark).join(" · ")} (od ${names[0]})`;
    return items.map((i) => `${mark(i)} (${i.by?.firstName ?? "manažér"})`).join(" · ");
}

// ── Prekryv odoslania s otvorenou úlohou (§5.1, W3-R2-05) ───────────────────

export const OVERLAP_CHOICES = ["KEEP_OPEN", "CANCEL_TASK"] as const;
export type OverlapChoice = (typeof OVERLAP_CHOICES)[number];

export function overlapsTask(open: { type: DealTaskType; contents: readonly DealTaskContent[] } | null, sent: readonly OfferContent[]): boolean {
    if (!open || open.type !== "HELP") return false;
    return (open.contents.includes("PRICE") && sent.includes("PRICE")) || (open.contents.includes("DESIGN") && sent.includes("DESIGN"));
}

// ── Odtlačok pre idempotentné opakovanie (§5.5) ─────────────────────────────
// Kanonický JSON toho, čo používateľ ODOSLAL (nie prepočítané hodnoty): kľúče objektov zoradené, množiny zoradí volajúci.

export function canonical(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object" && !(value instanceof Date)) {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
                .sort()
                .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
        );
    }
    return value ?? null;
}

export function sortedItems<T extends { taskId: string; kind: string; designId?: string }>(items: readonly T[] | null | undefined): T[] {
    return [...(items ?? [])].sort((a, b) => itemKey(a as ItemRef).localeCompare(itemKey(b as ItemRef)));
}

export function fpOfMeta(meta: unknown): string {
    return meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as { fp?: unknown }).fp === "string"
        ? (meta as { fp: string }).fp
        : "";
}

// ── Stránka „Pre mňa" ────────────────────────────────────────────────────────

export const TASK_AGE_ALERT_DAYS = 2; // po dvoch obchodných dňoch sa vek úlohy zafarbí na červeno
