import { z } from "zod";
import type {
    DealTaskContent,
    DealTaskPartStatus,
    DealTaskStatus,
    DealTaskType,
    NextActionKind,
    RequestContent,
} from "@/app/generated/prisma/enums";
import { contentOfTask, isSystemStep, stepKindForOutstanding } from "@/lib/domain/clientRequests";
import { formatMoney, type OfferContent } from "@/lib/domain/offers";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind } from "@/lib/domain/leadFlow";

// Úlohy pre manažéra (wave 3 – context/features/01-salesrep/wave-3-task-proposal-final.md,
// wave 4 – wave-4-proposal.md §2). Čisté pravidlá bez DB: dá sa importovať aj z klientskych komponentov.
// Zápisy sú v lib/domain/taskMutations.ts.
//
// Úloha = obchodník žiada manažéra o cenu / návrh / iné (HELP) alebo o prevzatie klienta (HANDOVER).
// Wave 4: jedna HELP úloha nesie NIEKOĽKO ČASTÍ (DealTaskPart), po jednej na druh práce. Každá sa dodáva,
// zamieta a sťahuje samostatne a stav ÚLOHY je z nich odvodený (taskStatusOfParts) – nikdy nastavený ručne.
// Zámok = obchod má OPEN úlohu → ďalší krok je zamknutý (odvodené, nič sa neukladá). SQL dvojča zámku je
// STEP_LOCKED_SQL v lib/queries/pipeline (paritný test v check-concurrency.ts).

export const TASK_CONTENTS = ["PRICE", "DESIGN", "OTHER"] as const satisfies readonly DealTaskContent[];
export const TASK_TYPES = ["HELP", "HANDOVER"] as const satisfies readonly DealTaskType[];

export const TASK_TEXT_MAX = 2000;
export const TASK_REASON_MAX = 500;

// P6 záložný krok úlohy (R02-1): manuálne zvolený krok pred úlohou (Zavolať, Čakáme, vlastný) sa vráti tak, ako bol.
// Systémový „Poslať …“ (alebo žiadny) sa NIKDY neuchová – jeho práca sa medzitým mohla odoslať a zamknutý krok by potom
// tvrdil, že sa má poslať znova. Bezpečný krok po úlohe je Zavolať s neutrálnou poznámkou.
export const NEUTRAL_FALLBACK_NOTE = "Pokračovať s klientom po odpovedi manažéra";
export function helpFallback(step: { kind: NextActionKind | null; note: string | null }): { kind: NextActionKind; note: string | null } {
    if (step.kind === null || isSystemStep(step.kind)) return { kind: "CALL", note: NEUTRAL_FALLBACK_NOTE };
    return { kind: step.kind, note: step.note };
}

// Zamknutá úloha čaká už len na otázku / konzultáciu: nič klientske sa neposiela (R02-1). Riadok a detail vtedy
// nesmú ukázať „Poslať …“ ani konajúci „Zavolať“, ale na koho sa čaká.
export function waitingOnQuestionHeadline(
    task: { type: DealTaskType; openKinds: readonly DealTaskContent[]; assignee: string } | null,
    outstanding: readonly unknown[],
    prepared: readonly unknown[],
): string | null {
    if (!task || task.type !== "HELP" || task.openKinds.length === 0) return null;
    if (outstanding.length > 0 || prepared.length > 0) return null;
    if (!task.openKinds.every((k) => k === "OTHER")) return null;
    return `Čaká na ${task.assignee} – otázka / konzultácia`;
}

// Poradie častí na karte a v odtlačkoch – jedno, aby dva zoznamy nikdy nepovedali to isté inak.
export function sortTaskContents(contents: readonly DealTaskContent[]): DealTaskContent[] {
    return TASK_CONTENTS.filter((c) => contents.includes(c));
}

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
// Wave 4: úloha nesie cenu AJ návrh naraz, takže `contents` je 1–3 druhy a krok vyjde z ich zjednotenia
// s nevybavenou prácou. Wave 5: druh kroku sa neodvodzuje len z obsahu úlohy, ale z celej nevybavenej práce
// (§6.8) – „Iné" na obchode, kde klient čaká na cenu, teda ostáva pri „Poslať cenu".

export type StepAfterTask = { kind: FollowUpNextKind; note: string | null; fixed: boolean };

export function stepAfterTask(
    contents: readonly DealTaskContent[],
    current: { kind: NextActionKind | null; note: string | null },
    pending: readonly { kind: ItemKind }[],
    defaultNote: (kind: NextActionKind) => string | null,
    outstanding: readonly RequestContent[] = [],
): StepAfterTask {
    const all = [...outstanding, ...contents.map(contentOfTask).filter((c): c is RequestContent => c !== null)];
    // „Pevný" ostáva o tom, ČO sa žiada: cena / návrh sa musia poslať, takže krok sa nevyberá. Pri „Iné" si krok
    // obchodník zvoliť môže – nevybavená práca mu ho len zúži (I10, assertStepAllowed).
    const fixed = contents.includes("DESIGN") || contents.includes("PRICE");
    let kind: FollowUpNextKind = (stepKindForOutstanding(all) as FollowUpNextKind | null) ?? current.kind ?? "CALL";
    const required = requiredStepKinds(pending);
    if (required && !required.includes(kind)) kind = required[0] as FollowUpNextKind;
    return { kind, note: kind === current.kind ? (current.note ?? null) : defaultNote(kind), fixed };
}

// Pri úlohe „Iné" sa krok dá zmeniť – na čo (I10 ho pri čakajúcich výsledkoch zúži).
export function choosableStepKinds(pending: readonly { kind: ItemKind }[]): FollowUpNextKind[] {
    const required = requiredStepKinds(pending);
    return FOLLOW_UP_NEXT_KINDS.filter((k) => !required || required.includes(k));
}

// ── Výsledok časti ───────────────────────────────────────────────────────────

const moneyString = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

export const taskDesignSnapshot = z
    .object({ id: z.string().min(1), label: z.string().nullable(), url: z.string().min(1), version: z.number().int().min(1) })
    .strict();

// Nemenný záznam toho, čo manažér dodal (aktuálna cena / návrh sa neskôr môžu zmeniť). Wave 4: patrí ČASTI –
// jedna časť nesie práve jeden z týchto kľúčov a zapisuje sa raz (Q11: po odovzdaní sa už neprepisuje).
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

// Ktorý kľúč výsledku patrí ktorému druhu práce – jedno miesto pre zápis aj pre kontrolu.
export function resultKeyOf(kind: DealTaskContent): "price" | "designs" | "answer" {
    return kind === "PRICE" ? "price" : kind === "DESIGN" ? "designs" : "answer";
}

// ── Vrátené položky (§6.13, wave 4 §2.5) ────────────────────────────────────
// PRICE jedna na časť, DESIGN jedna na (časť, návrh), OTHER (odpoveď) a DECLINED (dôvod) jedna na časť.
// Položku spotrebuje len odoslanie, ktoré ju menuje v OFFER_SENT.meta.fulfils, alebo TASK_RESULT_DISMISSED
// s meta.items.

export const ITEM_KINDS = ["PRICE", "DESIGN", "OTHER", "DECLINED"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

// `part` nesie LEN zamietnutie (wave 4): dve zamietnuté časti jednej úlohy sú dve samostatné potvrdenia.
export type ItemRef = { taskId: string; kind: ItemKind; designId?: string; part?: DealTaskContent };

export function itemKey(item: ItemRef): string {
    return `${item.taskId}:${item.kind}:${
        item.kind === "DESIGN" ? (item.designId ?? "") : item.kind === "DECLINED" ? (item.part ?? "") : ""
    }`;
}

const designIdRule = (i: { kind: string; designId?: string }) => (i.kind === "DESIGN" ? Boolean(i.designId) : i.designId === undefined);
const partRule = (i: { kind: string; part?: string }) => (i.kind === "DECLINED" ? true : i.part === undefined);

// Čo odoslanie použilo (OFFER_SENT.meta.fulfils) – len cena a návrh sa posielajú, tie `part` nikdy nenesú.
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
    .object({
        taskId: z.string().min(1),
        kind: z.enum(ITEM_KINDS),
        designId: z.string().min(1).optional(),
        part: z.enum(TASK_CONTENTS).optional(),
    })
    .strict()
    .refine(designIdRule, "DESIGN potrebuje designId, iné nie")
    .refine(partRule, "part nesie len zamietnutie");
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
    items: z.array(z.object({ kind: z.enum(ITEM_KINDS), designId: z.string().optional(), part: z.enum(TASK_CONTENTS).optional() })),
    reason: z.string().nullish(),
});
const fulfilsMetaSchema = z.object({ fulfils: fulfilsSchema });

export function dismissedItemsOfMeta(taskId: string | null, meta: unknown): ItemRef[] {
    const parsed = dismissalMetaSchema.safeParse(meta);
    if (!taskId || !parsed.success) return [];
    return parsed.data.items.map((i) => ({
        taskId,
        kind: i.kind,
        ...(i.kind === "DESIGN" && i.designId ? { designId: i.designId } : {}),
        ...(i.kind === "DECLINED" && i.part ? { part: i.part } : {}),
    }));
}

// Prečo sa to neposlalo / že sa to len vzalo na vedomie – patrí k osudu položky, nie k celej úlohe.
export function dismissalReasonOfMeta(meta: unknown): string | null {
    const parsed = dismissalMetaSchema.safeParse(meta);
    return parsed.success ? (parsed.data.reason ?? null) : null;
}

export function fulfilsOfMeta(meta: unknown): ItemRef[] {
    const parsed = fulfilsMetaSchema.safeParse(meta);
    if (!parsed.success) return [];
    return parsed.data.fulfils.map((f) => ({ taskId: f.taskId, kind: f.kind, ...(f.designId ? { designId: f.designId } : {}) }));
}

export type Person = { id: string; firstName: string };

// Jedna časť úlohy tak, ako ju čítajú čisté pravidlá (riadok DealTaskPart + mená ľudí).
export type PartRow = {
    kind: DealTaskContent;
    status: DealTaskPartStatus;
    result: unknown;
    addedBy: Person | null;
    addedAt: Date;
    resolvedBy: Person | null;
    resolvedAt: Date | null;
    reason: string | null;
};

export type TaskWithParts = {
    id: string;
    type: DealTaskType;
    status: DealTaskStatus;
    parts: readonly PartRow[];
};

export type PendingItem = ItemRef & {
    label: string; // „cena 1 285 €" / „návrh Variant A" / „odpoveď" / „zamietnuté"
    text: string | null; // odpoveď / dôvod zamietnutia
    price?: { amount: string; note: string | null };
    design?: TaskDesignSnapshot;
    by: Person | null; // kto tú časť vyriešil
    closedAt: string | null; // kedy ju vyriešil (nie kedy skončila celá úloha)
};

// Čo jedna časť vrátila. REQUESTED a WITHDRAWN nevracajú nič: prvá ešte nič nedodala, druhá sa stiahla.
export function partItems(taskId: string, part: PartRow): PendingItem[] {
    const base = { taskId, by: part.resolvedBy, closedAt: part.resolvedAt?.toISOString() ?? null };
    if (part.status === "DECLINED") {
        return [{ ...base, kind: "DECLINED", part: part.kind, label: "zamietnuté", text: part.reason }];
    }
    if (part.status !== "DELIVERED") return [];
    const result = parseTaskResult(part.result);
    if (!result) return [];
    const out: PendingItem[] = [];
    if (part.kind === "PRICE" && result.price) {
        out.push({ ...base, kind: "PRICE", label: `cena ${formatMoney(result.price.amount)}`, text: null, price: result.price });
    }
    if (part.kind === "DESIGN") {
        for (const d of result.designs ?? []) {
            out.push({ ...base, kind: "DESIGN", designId: d.id, label: `návrh ${d.label ?? d.url}`, text: null, design: d });
        }
    }
    if (part.kind === "OTHER" && result.answer) out.push({ ...base, kind: "OTHER", label: "odpoveď", text: result.answer });
    return out;
}

// Všetky položky, ktoré časti vrátili (v poradí vyriešenia ČASTI), bez ohľadu na spotrebu. Wave 4: aj OTVORENÁ
// úloha vracia položky – cena môže byť dodaná, kým sa návrh ešte robí (§2.1 bod 5).
export function returnedItems(tasks: readonly TaskWithParts[]): PendingItem[] {
    const rows: { at: number; taskId: string; kind: DealTaskContent; items: PendingItem[] }[] = [];
    for (const t of tasks) {
        if (t.type !== "HELP") continue; // prijaté odovzdanie nič nevracia
        for (const part of t.parts) {
            const items = partItems(t.id, part);
            if (items.length) rows.push({ at: part.resolvedAt?.getTime() ?? 0, taskId: t.id, kind: part.kind, items });
        }
    }
    rows.sort((a, b) => a.at - b.at || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) || TASK_CONTENTS.indexOf(a.kind) - TASK_CONTENTS.indexOf(b.kind));
    return rows.flatMap((r) => r.items);
}

// Nespotrebované položky: nič platné ich neposlalo (prečiarknuté odoslanie sa nepočíta) a nikto ich neodmietol.
export function pendingItems(
    tasks: readonly TaskWithParts[],
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

// sendCompletesStep sa presunul do lib/domain/clientRequests.ts – od wave 5 počíta s nevybavenými OBSAHMI
// (požiadavky klienta + práca manažéra), nie len s vrátenými položkami úloh (§6.4).

// Riadok v zozname: „✓ cena 1 285 € (Michal) · ✓ návrh Variant A (Nikolas)"; jedno meno na konci, keď sú od toho istého.
export function pendingSummary(items: readonly PendingItem[]): string | null {
    if (items.length === 0) return null;
    const mark = (i: PendingItem) => (i.kind === "DECLINED" ? `✗ ${i.text ? `„${i.text}“` : "zamietnuté"}` : `✓ ${i.label}`);
    const names = [...new Set(items.map((i) => i.by?.firstName ?? "manažér"))];
    if (names.length === 1) return `${items.map(mark).join(" · ")} (od ${names[0]})`;
    return items.map((i) => `${mark(i)} (${i.by?.firstName ?? "manažér"})`).join(" · ");
}

// ── Stav častí, položiek a celej úlohy (wave 4 §2.3 – §2.5) ─────────────────
// ČASŤ má životný cyklus, každá VRÁTENÁ POLOŽKA má vlastný osud. Sú to dve rôzne veci a karta ich nesmie zliať
// (R02-2): návrh, ktorý sa vedome neposlal, by sa inak zobrazil ako „klient ho dostal".

export type ItemDisposition =
    | { state: "WAITING" }
    | { state: "SENT"; at: string; activityId: string } // offerInstant platného OFFER_SENT
    | { state: "DISMISSED"; at: string; by: Person | null; reason: string | null; activityId: string };

export type PartItemView = PendingItem & { disposition: ItemDisposition };

// Vstup musí niesť FAKTY, nie len odkazy – inak by čistá funkcia nevedela vyrobiť dátum, ktorý sľubuje.
export type Consumption = {
    ref: ItemRef;
    state: "SENT" | "DISMISSED";
    at: Date; // SENT: offerInstant(meta, createdAt) · DISMISSED: createdAt riadku
    by: Person | null;
    reason: string | null; // len DISMISSED
    activityId: string;
};

export type PartMark = "MAKING" | "PREPARED" | "PARTLY_SENT" | "SENT" | "DISMISSED" | "DECLINED" | "WITHDRAWN";

export type PartView = {
    kind: DealTaskContent;
    status: DealTaskPartStatus;
    addedBy: Person | null;
    addedAt: string;
    resolvedBy: Person | null;
    resolvedAt: string | null;
    reason: string | null; // DECLINED / WITHDRAWN
    items: PartItemView[]; // PRICE: jedna · DESIGN: jedna na návrh · OTHER / DECLINED: jedna
    mark: PartMark; // stručná značka (§2.3), odvodená z položiek – nikdy uložená
    waitingCount: number;
    sentCount: number;
    dismissedCount: number;
};

function dispositionOf(item: PendingItem, byKey: Map<string, Consumption>): ItemDisposition {
    const hit = byKey.get(itemKey(item));
    if (!hit) return { state: "WAITING" };
    if (hit.state === "SENT") return { state: "SENT", at: hit.at.toISOString(), activityId: hit.activityId };
    return { state: "DISMISSED", at: hit.at.toISOString(), by: hit.by, reason: hit.reason, activityId: hit.activityId };
}

// §2.4: stav ÚLOHY je funkcia jej častí a NEZÁVISÍ od poradia, v akom sa vyriešili.
// „DONE" znamená „niečo sa vrátilo", nie „všetko sa urobilo" (Q10) – karta dopovie pravdu značkami častí.
export function taskStatusOfParts(parts: readonly { status: DealTaskPartStatus }[]): DealTaskStatus {
    if (parts.some((p) => p.status === "REQUESTED")) return "OPEN";
    if (parts.some((p) => p.status === "DELIVERED")) return "DONE";
    if (parts.some((p) => p.status === "DECLINED")) return "DECLINED";
    return "CANCELLED";
}

// Značka DODANEJ časti z osudu jej položiek: poslané / čiastočne / vedome neposielané (⊘) / čaká na odoslanie.
export function partMarkOf(
    status: DealTaskPartStatus,
    n: { total: number; sentCount: number; dismissedCount: number; waitingCount: number },
): PartMark {
    if (status === "REQUESTED") return "MAKING";
    if (status === "DECLINED") return "DECLINED";
    if (status === "WITHDRAWN") return "WITHDRAWN";
    if (n.sentCount > 0) return n.sentCount === n.total ? "SENT" : "PARTLY_SENT";
    return n.waitingCount === 0 && n.dismissedCount > 0 ? "DISMISSED" : "PREPARED";
}

export function taskPartState(
    task: { id: string; type: DealTaskType; status: DealTaskStatus },
    parts: readonly PartRow[],
    consumption: readonly Consumption[],
): { parts: PartView[]; openKinds: DealTaskContent[]; nextStatus: DealTaskStatus } {
    const byKey = new Map(consumption.map((c) => [itemKey(c.ref), c]));
    const ordered = [...parts].sort((a, b) => TASK_CONTENTS.indexOf(a.kind) - TASK_CONTENTS.indexOf(b.kind));
    const views: PartView[] = ordered.map((part) => {
        const items: PartItemView[] = partItems(task.id, part).map((i) => ({ ...i, disposition: dispositionOf(i, byKey) }));
        const sentCount = items.filter((i) => i.disposition.state === "SENT").length;
        const dismissedCount = items.filter((i) => i.disposition.state === "DISMISSED").length;
        const waitingCount = items.length - sentCount - dismissedCount;
        const mark = partMarkOf(part.status, { total: items.length, sentCount, dismissedCount, waitingCount });
        return {
            kind: part.kind,
            status: part.status,
            addedBy: part.addedBy,
            addedAt: part.addedAt.toISOString(),
            resolvedBy: part.resolvedBy,
            resolvedAt: part.resolvedAt?.toISOString() ?? null,
            reason: part.reason,
            items,
            mark,
            waitingCount,
            sentCount,
            dismissedCount,
        };
    });
    // HANDOVER nemá časti – jeho stav riadi prijatie odovzdania, nie prepočet.
    const nextStatus = task.type === "HELP" && parts.length > 0 ? taskStatusOfParts(parts) : task.status;
    return { parts: views, openKinds: views.filter((p) => p.status === "REQUESTED").map((p) => p.kind), nextStatus };
}

// Stručná značka časti do jednej vety – karta, riadok zoznamu aj schránka manažéra čítajú to isté.
export function partMarkLabel(part: Pick<PartView, "mark" | "items" | "sentCount" | "dismissedCount" | "waitingCount" | "reason">): string {
    switch (part.mark) {
        case "MAKING":
            return "robí sa";
        case "DECLINED":
            return part.reason ? `nerobí sa – ${part.reason}` : "nerobí sa";
        case "WITHDRAWN":
            return part.reason ? `stiahnuté – ${part.reason}` : "stiahnuté";
        case "SENT":
            return part.items.length > 1 ? `poslané klientovi (${part.items.length})` : "poslané klientovi";
        case "PARTLY_SENT": {
            const rest = part.dismissedCount ? ` · ${part.dismissedCount} neposlané` : "";
            return `${part.sentCount} z ${part.items.length} poslané${rest}`;
        }
        case "DISMISSED":
            return `neposiela sa (${part.dismissedCount})`;
        default:
            // Nič neodišlo, ale niečo ešte čaká na odoslanie.
            return part.dismissedCount ? `pripravené · ${part.dismissedCount} neposlané` : "pripravené";
    }
}

// Druh, ktorý sa smie znova vyžiadať: časť „v hre" je REQUESTED, alebo DELIVERED s aspoň jednou čakajúcou
// položkou (§2.3). DELIVERED a DECLINED sa v tej istej úlohe už nikdy nepýtajú znova.
export function partInPlay(part: Pick<PartView, "status" | "waitingCount">): boolean {
    return part.status === "REQUESTED" || (part.status === "DELIVERED" && part.waitingCount > 0);
}

// ── Prekryv odoslania s otvorenou úlohou (§5.1, W3-R2-05, wave 4 §2.8) ──────

export const OVERLAP_CHOICES = ["KEEP_OPEN", "WITHDRAW_PARTS"] as const;
export type OverlapChoice = (typeof OVERLAP_CHOICES)[number];

const OFFER_OF_TASK: Partial<Record<DealTaskContent, OfferContent>> = { PRICE: "PRICE", DESIGN: "DESIGN" };

// Ktoré ROBIACE SA časti toto odoslanie prekrýva. `fulfils` tu nič nepotláča a ani nemôže: @@unique([taskId, kind])
// znamená, že druh je v jednej úlohe buď REQUESTED, alebo DELIVERED – nikdy oboje. Vymyslená položka vo `fulfils`
// teda otázku obísť nedokáže (B5) a `validateFulfils` ju aj tak odmietne.
export function overlappingKinds(
    open: { type: DealTaskType; parts: readonly { kind: DealTaskContent; status: DealTaskPartStatus }[] } | null,
    sent: readonly OfferContent[],
): DealTaskContent[] {
    if (!open || open.type !== "HELP") return [];
    return sortTaskContents(
        open.parts
            .filter((p) => p.status === "REQUESTED")
            .map((p) => p.kind)
            .filter((k) => {
                const offer = OFFER_OF_TASK[k];
                return offer ? sent.includes(offer) : false;
            }),
    );
}

// „Už to netreba" pri odoslaní stiahne PRESNE ROBIACE SA časti, ktoré toto odoslanie prekrýva – nič iné (R01-4).
// Schéma dokáže overiť len tvar; či menované druhy naozaj patria k tomuto odoslaniu, vie povedať iba server pod zámkom.
export function withdrawMatchesOverlap(
    open: { id: string; type: DealTaskType; parts: readonly { kind: DealTaskContent; status: DealTaskPartStatus }[] } | null,
    sent: readonly OfferContent[],
    withdraw: { taskId: string; kinds: readonly DealTaskContent[] },
): boolean {
    if (!open || open.id !== withdraw.taskId) return false;
    const overlap = overlappingKinds(open, sent);
    return overlap.length > 0 && overlap.length === withdraw.kinds.length && overlap.every((k) => withdraw.kinds.includes(k));
}

// Zruší sa tým každá ešte robiaca sa časť, teda úloha skončí?
export function withdrawClosesTask(
    open: { parts: readonly { kind: DealTaskContent; status: DealTaskPartStatus }[] },
    kinds: readonly DealTaskContent[],
): boolean {
    return open.parts.filter((p) => p.status === "REQUESTED").every((p) => kinds.includes(p.kind));
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

export function sortedItems<T extends { taskId: string; kind: string; designId?: string; part?: string }>(items: readonly T[] | null | undefined): T[] {
    return [...(items ?? [])].sort((a, b) => itemKey(a as ItemRef).localeCompare(itemKey(b as ItemRef)));
}

export function fpOfMeta(meta: unknown): string {
    return meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as { fp?: unknown }).fp === "string"
        ? (meta as { fp: string }).fp
        : "";
}

// ── Stránka „Pre mňa" ────────────────────────────────────────────────────────

export const TASK_AGE_ALERT_DAYS = 2; // po dvoch obchodných dňoch sa vek úlohy zafarbí na červeno
