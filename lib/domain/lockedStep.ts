import type { Lead } from "@/app/generated/prisma/client";
import type { ActivitySource, DealTaskType } from "@/app/generated/prisma/enums";
import type { Tx } from "@/lib/access/locks";
import { createPlanningActivity, describeNextAction, type NextActionData } from "@/lib/activityLog";
import { businessTodayStart } from "@/lib/domain/businessTime";
import { defaultStep } from "@/lib/domain/clientRequests";
import { hadNextAction, updateLead } from "@/lib/domain/leadWrites";
import { outstandingOf } from "@/lib/domain/requestMutations";
import { helpFallback } from "@/lib/domain/tasks";
import { openTaskOf } from "@/lib/domain/taskMutations";

// P6 (wave 4 §2.6): KÝM JE ÚLOHA OTVORENÁ, ďalší krok nie je uložené rozhodnutie, ale ČISTÁ FUNKCIA:
//
//     lockedStep = defaultStep(outstanding, lead, { locked: true })  ??  { kind: task.fallbackKind, note: task.fallbackNote }
//
// Prepočíta sa pri každej udalosti, ktorá mení nevybavenú prácu – dodanie, zamietnutie, stiahnutie či pridanie
// časti, odoslanie klientovi počas otvorenej úlohy, oprava takého odoslania, ceruzka pri „Chceli". Dátum ostáva
// NULL a režim SCHEDULED (P5, I8), stav obchodu sa nemení a obchod ostáva v „Čakám na manažéra".
//
// Prečo to NESMIE byť vo vnútri recordOffer (B1): `factOnly` znamená na štyroch miestach dve rôzne veci – raz
// „krok je zamknutý", raz „používateľ si krok vedome ponechal" (SMS keepStep, obyčajný hovor s cenou). Prepočet
// v takej vetve by na obchode BEZ úlohy zmazal dátum kroku. Prepočet preto vlastní PRÍKAZ a volá ho výslovne.
//
// Prečo tu nie je `isSystemStep` (P3): kým je úloha otvorená, zámok už voľnému preplánovaniu bráni a záložný krok
// drží vlastnú voľbu používateľa – dohodnutý hovor teda smie dočasne ustúpiť kroku „Poslať cenu" a po stiahnutí
// tej časti sa vráti. Na ODOMKNUTOM obchode platí P3 v plnej sile.
export async function refreshLockedStep(tx: Tx, actor: { id: string }, lead: Lead, source: ActivitySource): Promise<void> {
    const open = await openTaskOf(tx, lead.id);
    if (!open) return;
    const next = await lockedStepFor(tx, lead, open);
    if (!next || next.nextActionKind === lead.nextActionKind) return;
    await updateLead(tx, lead.id, next);
    await tx.activity.create({
        data: createPlanningActivity({
            leadId: lead.id,
            userId: actor.id,
            type: !next.nextActionKind ? "NEXT_ACTION_CLEARED" : hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
            source,
            note: `${describeNextAction(next)} · 🔒 čaká na úlohu`,
        }),
    });
}

// Samotný vzorec. `null` = nedá sa povedať nič lepšie než to, čo je uložené (konvertovaná úloha bez záložného kroku).
export async function lockedStepFor(
    tx: Tx,
    lead: Lead,
    task: { type?: DealTaskType; fallbackKind: Lead["nextActionKind"]; fallbackNote: string | null },
): Promise<NextActionData | null> {
    const derived = defaultStep(await outstandingOf(tx, lead.id), lead, { locked: true });
    if (derived) return derived;
    // Nič na odoslanie – napr. ostalo len „Iné". Krok padá na to, čo obchod mal pred zamknutím (R02-3).
    // Odovzdanie klienta nemá časti ani neutrálny krok – ostáva to, čo je uložené.
    if (task.type === "HANDOVER") return task.fallbackKind ? { ...lockedFields(task.fallbackKind), nextActionNote: task.fallbackNote } : null;
    // Ručne zvolený krok sa vráti; systémový „Poslať …“ (alebo žiadny) sa nahradí neutrálnym „Zavolať“ – jeho práca
    // sa medzitým mohla odoslať (R02-1). Aj staršia úloha s uloženým systémovým krokom tak dostane neutrálny.
    const fallback = helpFallback({ kind: task.fallbackKind, note: task.fallbackNote });
    return { ...lockedFields(fallback.kind), nextActionNote: fallback.note };
}

function lockedFields(kind: NonNullable<Lead["nextActionKind"]>) {
    return { nextActionKind: kind, nextActionAt: null, nextActionHasTime: false, nextActionMode: "SCHEDULED" as const };
}

// Koniec úlohy: naposledy ten istý vzorec (aby krok neostal pri tom, čo už odišlo), a hneď aj odomknutie –
// jeden zápis, jeden riadok histórie, ktorý hovorí konečný stav (nie krok bez termínu a potichu doplnený dátum).
// Zámerne sa NEVOLÁ defaultStep bez `locked`: ten by kroku „Poslať návrh" nastavil režim IN_PROGRESS a obchod by
// sa uzavretím úlohy potichu presunul z „Na dnes" do „Rozpracované" (B3; F2 vo wave-5-followups.md je Michalovo
// otvorené rozhodnutie a wave 4 ho nesmie urobiť za neho). Režim teda ostáva, aký bol – a kým bol krok zamknutý,
// bol SCHEDULED (P5).
export async function stepOnTaskClose(
    tx: Tx,
    actor: { id: string },
    lead: Lead,
    task: { type?: DealTaskType; fallbackKind: Lead["nextActionKind"]; fallbackNote: string | null },
    source: ActivitySource,
    now = new Date(),
): Promise<void> {
    const derived = await lockedStepFor(tx, lead, task);
    const kind = derived?.nextActionKind ?? lead.nextActionKind;
    const note = derived ? derived.nextActionNote : lead.nextActionNote;
    if (!kind) {
        await updateLead(tx, lead.id, {});
        return;
    }
    const next: NextActionData = {
        nextActionKind: kind,
        nextActionAt: businessTodayStart(now),
        nextActionHasTime: false,
        nextActionMode: lead.nextActionMode,
        nextActionNote: note,
    };
    await updateLead(tx, lead.id, next);
    if (kind === lead.nextActionKind) return; // len odomknutie – planning riadok by nič nepovedal
    await tx.activity.create({
        data: createPlanningActivity({
            leadId: lead.id,
            userId: actor.id,
            type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
            source,
            note: describeNextAction(next),
        }),
    });
}
