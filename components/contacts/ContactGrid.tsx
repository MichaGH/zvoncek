"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { createContact } from "@/lib/actions/contacts";
import { cn } from "@/lib/utils";

type RowStatus = "draft" | "saving" | "saved" | "error";

type Row = {
    id: string;
    companyName: string;
    website: string;
    phone: string;
    note: string;
    status: RowStatus;
    savedNumber?: number;
    error?: string;
};

type Field = "companyName" | "website" | "phone" | "note";

let counter = 0;
function newRow(): Row {
    counter += 1;
    return {
        id: `row-${Date.now()}-${counter}`,
        companyName: "",
        website: "",
        phone: "",
        note: "",
        status: "draft",
    };
}

function isEmpty(row: Row) {
    return !row.companyName.trim() && !row.website.trim() && !row.phone.trim() && !row.note.trim();
}

// A contact needs a name (company or web) AND a phone. Returns the first missing
// thing as a message, or null when the row is ready to save.
function missingReason(row: Row): string | null {
    if (!row.companyName.trim() && !row.website.trim()) return "Vyplň firmu alebo web.";
    if (!row.phone.trim()) return "Telefón je povinný.";
    return null;
}

export default function ContactGrid({ initialCallable }: { initialCallable: number }) {
    const [rows, setRows] = useState<Row[]>(() => [newRow()]);
    const rowsRef = useRef(rows);
    useEffect(() => {
        rowsRef.current = rows;
    }, [rows]);

    // First input of each row, so Enter can jump to the next row.
    const firstInputs = useRef<Record<string, HTMLInputElement | null>>({});
    // Guards against double-saving the same row (blur + Enter firing together).
    const inFlight = useRef<Set<string>>(new Set());

    const savedCount = rows.filter((r) => r.status === "saved").length;
    const hasUnsaved = rows.some((r) => r.status !== "saved" && !isEmpty(r));

    // Don't let people lose half-typed contacts by closing the tab.
    useEffect(() => {
        if (!hasUnsaved) return;
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [hasUnsaved]);

    const updateField = useCallback((id: string, field: Field, value: string) => {
        setRows((prev) => {
            const next = prev.map((row) =>
                row.id === id
                    ? {
                          ...row,
                          [field]: value,
                          // Editing an errored row turns it back into an editable draft.
                          status: row.status === "error" ? ("draft" as RowStatus) : row.status,
                          error: row.status === "error" ? undefined : row.error,
                      }
                    : row,
            );
            // Always keep exactly one trailing empty row to type into.
            const last = next[next.length - 1];
            if (last && !isEmpty(last)) next.push(newRow());
            return next;
        });
    }, []);

    const saveRow = useCallback(async (id: string) => {
        const row = rowsRef.current.find((r) => r.id === id);
        if (!row) return;
        if (row.status === "saving" || row.status === "saved") return;
        if (isEmpty(row)) return;
        if (inFlight.current.has(id)) return;

        const missing = missingReason(row);
        if (missing) {
            setRows((prev) =>
                prev.map((r) => (r.id === id ? { ...r, status: "error", error: missing } : r)),
            );
            return;
        }

        inFlight.current.add(id);
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "saving", error: undefined } : r)));

        const result = await createContact({
            companyName: row.companyName,
            website: row.website,
            phone: row.phone,
            note: row.note,
        });
        inFlight.current.delete(id);

        setRows((prev) =>
            prev.map((r) =>
                r.id === id
                    ? result.ok
                        ? { ...r, status: "saved", savedNumber: result.number, error: undefined }
                        : { ...r, status: "error", error: result.error }
                    : r,
            ),
        );
    }, []);

    function handleRowBlur(id: string, e: React.FocusEvent<HTMLDivElement>) {
        // Only save when focus actually leaves the row (not when tabbing between its cells).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        saveRow(id);
    }

    function handleKeyDown(id: string, e: React.KeyboardEvent) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        saveRow(id);
        const list = rowsRef.current;
        const idx = list.findIndex((r) => r.id === id);
        const next = list[idx + 1];
        if (next) {
            // Defer so the freshly-appended empty row is mounted before we focus it.
            setTimeout(() => firstInputs.current[next.id]?.focus(), 0);
        }
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3">
                <div>
                    <span className="text-2xl font-semibold tabular-nums text-emerald-600">
                        {initialCallable + savedCount}
                    </span>{" "}
                    <span className="text-sm text-muted-foreground">voľných na volanie</span>
                </div>
                {savedCount > 0 && (
                    <div className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground tabular-nums">{savedCount}</span>{" "}
                        práve pridaných
                    </div>
                )}
            </div>

            <div className="overflow-x-auto rounded-lg border bg-card">
                <div className="min-w-[820px]">
                    <div className="grid grid-cols-[1.4fr_1fr_0.9fr_1.6fr_5.5rem] border-b bg-muted/50 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <HeaderCell>Firma</HeaderCell>
                        <HeaderCell>Web</HeaderCell>
                        <HeaderCell>Telefón</HeaderCell>
                        <HeaderCell>Poznámka</HeaderCell>
                        <HeaderCell className="border-r-0 text-center">Stav</HeaderCell>
                    </div>

                    {rows.map((row) => {
                        const saved = row.status === "saved";
                        return (
                            <div
                                key={row.id}
                                onBlur={(e) => handleRowBlur(row.id, e)}
                                className={cn(
                                    "grid grid-cols-[1.4fr_1fr_0.9fr_1.6fr_5.5rem] border-b last:border-b-0",
                                    saved && "bg-emerald-50/60",
                                    row.status === "error" && "bg-destructive/5",
                                )}
                            >
                                <GridInput
                                    ref={(el) => {
                                        firstInputs.current[row.id] = el;
                                    }}
                                    value={row.companyName}
                                    onChange={(v) => updateField(row.id, "companyName", v)}
                                    onKeyDown={(e) => handleKeyDown(row.id, e)}
                                    disabled={saved}
                                    placeholder="Autoservis Kováč"
                                />
                                <GridInput
                                    value={row.website}
                                    onChange={(v) => updateField(row.id, "website", v)}
                                    onKeyDown={(e) => handleKeyDown(row.id, e)}
                                    disabled={saved}
                                    placeholder="kovac.sk"
                                />
                                <GridInput
                                    value={row.phone}
                                    onChange={(v) => updateField(row.id, "phone", v)}
                                    onKeyDown={(e) => handleKeyDown(row.id, e)}
                                    disabled={saved}
                                    placeholder="0905 123 456"
                                    inputMode="tel"
                                />
                                <GridInput
                                    value={row.note}
                                    onChange={(v) => updateField(row.id, "note", v)}
                                    onKeyDown={(e) => handleKeyDown(row.id, e)}
                                    disabled={saved}
                                    placeholder="stará stránka, len vizitka…"
                                    last
                                />
                                <StatusCell row={row} onRetry={() => saveRow(row.id)} />

                                {row.status === "error" && row.error && (
                                    <p className="col-span-full border-t border-destructive/20 px-3 py-1.5 text-xs text-destructive">
                                        {row.error}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            <p className="text-sm text-muted-foreground">
                Vyplň riadok a stlač Enter – uloží sa sám. Nový riadok pribudne automaticky.
            </p>
        </div>
    );
}

function HeaderCell({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn("border-r px-3 py-2", className)}>{children}</div>;
}

type GridInputProps = {
    value: string;
    onChange: (value: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    disabled?: boolean;
    placeholder?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
    last?: boolean;
    ref?: React.Ref<HTMLInputElement>;
};

function GridInput({ value, onChange, onKeyDown, disabled, placeholder, inputMode, last, ref }: GridInputProps) {
    return (
        <div className={cn(!last && "border-r")}>
            <input
                ref={ref}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={disabled}
                placeholder={placeholder}
                inputMode={inputMode}
                autoComplete="off"
                className="w-full bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:bg-accent/40 disabled:cursor-default disabled:text-muted-foreground"
            />
        </div>
    );
}

function StatusCell({ row, onRetry }: { row: Row; onRetry: () => void }) {
    return (
        <div className="flex items-center justify-center px-2 py-2">
            {row.status === "saving" && <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />}
            {row.status === "saved" && (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <CheckIcon className="h-4 w-4" />#{row.savedNumber}
                </span>
            )}
            {row.status === "error" && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center gap-1 text-xs font-medium text-destructive hover:underline"
                >
                    <TriangleAlertIcon className="h-4 w-4" />
                    Znova
                </button>
            )}
        </div>
    );
}
