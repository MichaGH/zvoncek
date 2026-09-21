// SQL prevodu úloh na časti (wave 4 §6.3). HISTORICKÉ: prevod prebehol raz, 2026-09-20, a krokom S-13b zmizli
// stĺpce `DealTask.contents` / `result`, na ktoré sa väčšina týchto dotazov pýta. Ostáva ako presný záznam toho,
// čo sa spustilo. Jediný dotaz, ktorý platí aj dnes, je POST_CUTOVER_SQL.
//
// Do prepnutia kódu je DealTaskPart ČISTÉ ODVODENIE rodiča – nič ho nečíta a nič iné doň nepíše. Preto prevod
// zmaže všetky časti a vytvorí ich nanovo: je presne reprodukovateľný a dá sa opakovať bez driftu.

// HANDOVER nemá časti (prijaté odovzdanie nič nevracia).
export const DELETE_ALL_PARTS = `DELETE FROM "DealTaskPart"`;

// Jedna časť na každý obsah HELP úlohy. Stav a výsledok sa odvodia od rodiča (§6.3 bod 2).
export const INSERT_PARTS = `
INSERT INTO "DealTaskPart" ("id", "taskId", "kind", "status", "result", "addedById", "addedAt", "resolvedById", "resolvedAt", "reason")
SELECT
    md5(t.id || ':' || c.kind::text) AS id,
    t.id,
    c.kind,
    CASE t.status
        WHEN 'OPEN' THEN 'REQUESTED'
        WHEN 'DONE' THEN 'DELIVERED'
        WHEN 'DECLINED' THEN 'DECLINED'
        ELSE 'WITHDRAWN'
    END::"DealTaskPartStatus",
    CASE
        WHEN t.status <> 'DONE' THEN NULL
        WHEN c.kind = 'PRICE' THEN jsonb_build_object('price', t.result -> 'price')
        WHEN c.kind = 'DESIGN' THEN jsonb_build_object('designs', t.result -> 'designs')
        ELSE jsonb_build_object('answer', t.result -> 'answer')
    END,
    t."requestedById",
    t."createdAt",
    CASE WHEN t.status = 'OPEN' THEN NULL ELSE t."closedById" END,
    CASE WHEN t.status = 'OPEN' THEN NULL ELSE t."closedAt" END,
    CASE WHEN t.status IN ('DECLINED', 'CANCELLED') THEN t."closeReason" ELSE NULL END
FROM "DealTask" t
CROSS JOIN LATERAL (SELECT DISTINCT unnest(t.contents) AS kind) c
WHERE t.type = 'HELP'
`;

// ── Podmienky na prerušenie (§6.3 bod 4): hlás, nehádaj ──────────────────────

export const ABORTS: { id: string; why: string; sql: string }[] = [
    {
        id: "emptyContents",
        why: "HELP úloha bez jediného obsahu – nevie sa, čo sa žiadalo",
        sql: `SELECT t.id FROM "DealTask" t WHERE t.type = 'HELP' AND coalesce(array_length(t.contents, 1), 0) = 0`,
    },
    {
        id: "duplicateContents",
        why: "obsah je v poli dvakrát – @@unique([taskId, kind]) by zápis zhodil v polovici (B9)",
        sql: `
SELECT t.id FROM "DealTask" t
 WHERE t.type = 'HELP'
   AND (SELECT count(DISTINCT x) FROM unnest(t.contents) x) <> coalesce(array_length(t.contents, 1), 0)`,
    },
    {
        id: "missingResultSlice",
        why: "vybavená úloha nemá vo výsledku to, čo mala zaškrtnuté (I5 to má vylúčiť)",
        sql: `
SELECT t.id FROM "DealTask" t
CROSS JOIN LATERAL (SELECT DISTINCT unnest(t.contents) AS kind) c
 WHERE t.type = 'HELP' AND t.status = 'DONE'
   AND (t.result -> CASE c.kind WHEN 'PRICE' THEN 'price' WHEN 'DESIGN' THEN 'designs' ELSE 'answer' END) IS NULL`,
    },
    {
        id: "extraResultKey",
        why: "výsledok nesie kľúč, ktorý žiadnemu zaškrtnutému obsahu nezodpovedá",
        sql: `
SELECT t.id FROM "DealTask" t
CROSS JOIN LATERAL jsonb_object_keys(coalesce(t.result, '{}'::jsonb)) AS k
 WHERE t.type = 'HELP' AND t.status = 'DONE'
   AND NOT (CASE k WHEN 'price' THEN 'PRICE' WHEN 'designs' THEN 'DESIGN' WHEN 'answer' THEN 'OTHER' ELSE '' END = ANY (t.contents::text[]))`,
    },
    {
        id: "handoverWithContents",
        why: "odovzdanie má obsah – časti preň nevznikajú a údaj by sa stratil",
        sql: `SELECT t.id FROM "DealTask" t WHERE t.type = 'HANDOVER' AND coalesce(array_length(t.contents, 1), 0) > 0`,
    },
    {
        id: "unmatchableDismissal",
        why: "potvrdené zamietnutie sa nedá priradiť práve jednému obsahu – po prevode by sa vrátilo ako čakajúce",
        sql: `
SELECT a.id FROM "Activity" a
JOIN "DealTask" t ON t.id = a."taskId"
CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.meta -> 'items', '[]'::jsonb)) AS i
 WHERE a.type = 'TASK_RESULT_DISMISSED'
   AND i ->> 'kind' = 'DECLINED'
   AND i ->> 'part' IS NULL
   AND coalesce(array_length(t.contents, 1), 0) <> 1`,
    },
];

// Staré potvrdenia zamietnutia menujú úlohu, nie časť. Po prevode má položka adresu (taskId, DECLINED, part),
// takže bez doplnenia `part` by sa už potvrdené zamietnutie vrátilo medzi čakajúce (§6.3 bod 6).
export const REWRITE_DISMISSALS = `
UPDATE "Activity" a
   SET meta = jsonb_set(
        a.meta,
        '{items}',
        (SELECT jsonb_agg(
                    CASE WHEN i ->> 'kind' = 'DECLINED' AND i ->> 'part' IS NULL
                         THEN i || jsonb_build_object('part', t.contents[1]::text)
                         ELSE i END)
           FROM jsonb_array_elements(a.meta -> 'items') AS i))
  FROM "DealTask" t
 WHERE t.id = a."taskId"
   AND a.type = 'TASK_RESULT_DISMISSED'
   AND array_length(t.contents, 1) = 1
   AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(a.meta -> 'items', '[]'::jsonb)) AS i
         WHERE i ->> 'kind' = 'DECLINED' AND i ->> 'part' IS NULL)
`;

// Po prepnutí kódu (§9 krok 7) sú časti ZDROJOM PRAVDY a už sa nikdy neodvodzujú znova. Tento dotaz nájde stav,
// ktorý čisté odvodenie z rodiča vyrobiť NEDOKÁŽE – teda dôkaz, že už tu boli noví zapisovatelia:
//   · otvorená úloha s časťou, ktorá sa už nerobí (čiastočné vybavenie),
//   · zavretá úloha, ktorej časti nie sú všetky v stave zodpovedajúcom rodičovi (zmiešaný koniec),
//   · časť vyriešená v inom čase než celá úloha.
// Kým niečo z toho existuje, opakovaný prevod by zmazal skutočnú prácu – preto sa odmietne.
export const POST_CUTOVER_SQL = `
SELECT DISTINCT t.id
  FROM "DealTask" t
  JOIN "DealTaskPart" p ON p."taskId" = t.id
 WHERE p.status <> CASE t.status
        WHEN 'OPEN' THEN 'REQUESTED' WHEN 'DONE' THEN 'DELIVERED' WHEN 'DECLINED' THEN 'DECLINED' ELSE 'WITHDRAWN' END::"DealTaskPartStatus"
    OR (t.status <> 'OPEN' AND p."resolvedAt" IS DISTINCT FROM t."closedAt")
`;

// ── Kontrola nulového driftu (§6.3 kroky 3 a 5) ──────────────────────────────
// Každý riadok, ktorý vráti niektorý z týchto dotazov, je rozdiel medzi rodičom a jeho časťami.

export const DRIFT_CHECKS: { id: string; why: string; sql: string }[] = [
    {
        id: "countMismatch",
        why: "počet častí nesedí s počtom obsahov úlohy",
        sql: `
SELECT t.id FROM "DealTask" t
 WHERE t.type = 'HELP'
   AND (SELECT count(*) FROM "DealTaskPart" p WHERE p."taskId" = t.id)
       <> (SELECT count(DISTINCT x) FROM unnest(t.contents) x)`,
    },
    {
        id: "handoverHasParts",
        why: "odovzdanie má časti",
        sql: `SELECT t.id FROM "DealTask" t WHERE t.type = 'HANDOVER' AND EXISTS (SELECT 1 FROM "DealTaskPart" p WHERE p."taskId" = t.id)`,
    },
    {
        id: "statusMismatch",
        why: "stav časti nezodpovedá stavu rodiča",
        sql: `
SELECT p.id FROM "DealTaskPart" p
JOIN "DealTask" t ON t.id = p."taskId"
 WHERE p.status <> CASE t.status
        WHEN 'OPEN' THEN 'REQUESTED' WHEN 'DONE' THEN 'DELIVERED' WHEN 'DECLINED' THEN 'DECLINED' ELSE 'WITHDRAWN' END::"DealTaskPartStatus"`,
    },
    {
        id: "resultMismatch",
        why: "výsledok časti nie je presne výrez výsledku rodiča",
        sql: `
SELECT p.id FROM "DealTaskPart" p
JOIN "DealTask" t ON t.id = p."taskId"
 WHERE p.status = 'DELIVERED'
   AND p.result IS DISTINCT FROM (
        CASE p.kind
            WHEN 'PRICE' THEN jsonb_build_object('price', t.result -> 'price')
            WHEN 'DESIGN' THEN jsonb_build_object('designs', t.result -> 'designs')
            ELSE jsonb_build_object('answer', t.result -> 'answer')
        END)`,
    },
    {
        id: "resolverMismatch",
        why: "kto / kedy časť uzavrel nesedí s rodičom",
        sql: `
SELECT p.id FROM "DealTaskPart" p
JOIN "DealTask" t ON t.id = p."taskId"
 WHERE (p."resolvedById" IS DISTINCT FROM CASE WHEN t.status = 'OPEN' THEN NULL ELSE t."closedById" END)
    OR (p."resolvedAt" IS DISTINCT FROM CASE WHEN t.status = 'OPEN' THEN NULL ELSE t."closedAt" END)`,
    },
    {
        id: "reasonMismatch",
        why: "dôvod časti nesedí s dôvodom rodiča",
        sql: `
SELECT p.id FROM "DealTaskPart" p
JOIN "DealTask" t ON t.id = p."taskId"
 WHERE p.reason IS DISTINCT FROM (CASE WHEN t.status IN ('DECLINED', 'CANCELLED') THEN t."closeReason" ELSE NULL END)`,
    },
    {
        id: "orphanKind",
        why: "časť má druh, ktorý rodič nežiadal",
        sql: `
SELECT p.id FROM "DealTaskPart" p
JOIN "DealTask" t ON t.id = p."taskId"
 WHERE NOT (p.kind::text = ANY (t.contents::text[]))`,
    },
    {
        id: "deliveredWithoutResult",
        why: "dodaná časť nemá výsledok",
        sql: `SELECT p.id FROM "DealTaskPart" p WHERE p.status = 'DELIVERED' AND (p.result IS NULL OR p.result = '{}'::jsonb)`,
    },
    {
        id: "openDismissalWithoutPart",
        why: "potvrdené zamietnutie stále menuje úlohu namiesto časti",
        sql: `
SELECT a.id FROM "Activity" a
CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.meta -> 'items', '[]'::jsonb)) AS i
 WHERE a.type = 'TASK_RESULT_DISMISSED' AND i ->> 'kind' = 'DECLINED' AND i ->> 'part' IS NULL`,
    },
];
