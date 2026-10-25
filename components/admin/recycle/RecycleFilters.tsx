"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Search, ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    CALL_BUCKETS,
    DEAL_BUCKETS,
    RECYCLE_BUCKET_LABEL,
    RECYCLE_GOT,
    RECYCLE_GOT_LABEL,
    RECYCLE_ASKED,
    RECYCLE_ASKED_LABEL,
    RECYCLE_HOLDER_NONE,
    RECYCLE_OLDER_OPTIONS,
    RECYCLE_SORTS,
    RECYCLE_SORT_LABEL,
    recycleHref,
    type RecycleBucket,
    type RecycleParams,
} from "@/lib/domain/recycling";
import { cn } from "@/lib/utils";

type Holder = { id: string; name: string; deactivated: boolean; count: number };

const ALL = "all";

// Čip koša – klik ho pridá alebo odoberie z výberu; počet je z toho istého predikátu ako zoznam.
function BucketChip({ params, bucket, count }: { params: RecycleParams; bucket: RecycleBucket; count: number }) {
    const on = params.buckets.includes(bucket);
    const buckets = on ? params.buckets.filter((b) => b !== bucket) : [...params.buckets, bucket];
    return (
        <Link
            href={recycleHref(params, { buckets })}
            aria-pressed={on}
            className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                on
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                count === 0 && !on && "opacity-55",
            )}
        >
            <span className="whitespace-nowrap">{RECYCLE_BUCKET_LABEL[bucket]}</span>
            <span className="tabular-nums text-xs opacity-80">{count}</span>
        </Link>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
        </div>
    );
}

function Pick({ label, value, onChange, options }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger size="sm" className="h-9 w-auto min-w-36 gap-1.5">
                <span className="text-muted-foreground">{label}</span>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                        {o.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export default function RecycleFilters({
    params,
    counts,
    holders,
    hiddenDoNotCall,
}: {
    params: RecycleParams;
    counts: Record<RecycleBucket, number>;
    holders: Holder[];
    hiddenDoNotCall: number;
}) {
    const router = useRouter();
    const [q, setQ] = useState(params.q);
    const go = (patch: Partial<RecycleParams>) => router.push(recycleHref(params, patch));

    return (
        <div className="space-y-3 rounded-lg border p-3">
            <Row label="Volania">
                {CALL_BUCKETS.map((b) => (
                    <BucketChip key={b} params={params} bucket={b} count={counts[b]} />
                ))}
            </Row>
            <Row label="Obchody">
                {DEAL_BUCKETS.map((b) => (
                    <BucketChip key={b} params={params} bucket={b} count={counts[b]} />
                ))}
            </Row>
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <Pick
                    label="Kto to mal:"
                    value={params.holder ?? ALL}
                    onChange={(v) => go({ holder: v === ALL ? null : v })}
                    options={[
                        { value: ALL, label: "všetci" },
                        ...holders.map((h) => ({
                            value: h.id,
                            label: `${h.id === RECYCLE_HOLDER_NONE ? "nikto" : h.name}${h.deactivated ? " (deaktivovaný)" : ""} · ${h.count}`,
                        })),
                        ...(params.holder && !holders.some((h) => h.id === params.holder)
                            ? [{ value: params.holder, label: "vybraný (0)" }]
                            : []),
                    ]}
                />
                <Pick
                    label="Posledný kontakt:"
                    value={String(params.older)}
                    onChange={(v) => go({ older: Number(v) })}
                    options={RECYCLE_OLDER_OPTIONS.map((d) => ({ value: String(d), label: d === 0 ? "hocikedy" : `pred viac ako ${d} dňami` }))}
                />
                <Pick
                    label="Nezdvihli:"
                    value={String(params.tries)}
                    onChange={(v) => go({ tries: Number(v) })}
                    options={[0, 1, 2, 3, 5].map((n) => ({ value: String(n), label: n === 0 ? "hocikoľko" : `aspoň ${n}×` }))}
                />
                <Pick
                    label="Klient:"
                    value={params.got ?? ALL}
                    onChange={(v) => go({ got: v === ALL ? null : (v as RecycleParams["got"]) })}
                    options={[{ value: ALL, label: "hocičo" }, ...RECYCLE_GOT.map((g) => ({ value: g, label: RECYCLE_GOT_LABEL[g] }))]}
                />
                <Pick
                    label="Požiadavka:"
                    value={params.asked ?? ALL}
                    onChange={(v) => go({ asked: v === ALL ? null : (v as RecycleParams["asked"]) })}
                    options={[{ value: ALL, label: "hocičo" }, ...RECYCLE_ASKED.map((a) => ({ value: a, label: RECYCLE_ASKED_LABEL[a] }))]}
                />
                <Pick
                    label="Kolo:"
                    value={params.round ?? ALL}
                    onChange={(v) => go({ round: v === ALL ? null : (v as RecycleParams["round"]) })}
                    options={[
                        { value: ALL, label: "všetky" },
                        { value: "1", label: "1. kolo" },
                        { value: "2", label: "2. a ďalšie" },
                    ]}
                />
                <Pick
                    label="Poradie:"
                    value={params.sort}
                    onChange={(v) => go({ sort: v as RecycleParams["sort"] })}
                    options={RECYCLE_SORTS.map((s) => ({ value: s, label: RECYCLE_SORT_LABEL[s] }))}
                />
                <form
                    className="relative min-w-48 flex-1"
                    onSubmit={(e) => {
                        e.preventDefault();
                        go({ q: q.trim() });
                    }}
                >
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Hľadať firmu, web, telefón, email, poznámku, #číslo"
                        className="h-9 pl-8"
                    />
                </form>
            </div>
            {/* R02-04: kontakty s „nevolať“ v poznámke / dôvode sú predvolene vynechané; zobraziť sa dajú vedome. */}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldAlert className="h-3.5 w-3.5" />
                {params.dnc === "hide" ? (
                    <>
                        Skryté – v poznámke „nevolať“: <span className="font-medium tabular-nums text-foreground">{hiddenDoNotCall}</span>
                        {hiddenDoNotCall > 0 && (
                            <Link href={recycleHref(params, { dnc: "show" })} className="underline underline-offset-2 hover:text-foreground">
                                zobraziť aj tieto
                            </Link>
                        )}
                    </>
                ) : (
                    <>
                        Zobrazené aj kontakty s „nevolať“ v poznámke.
                        <Link href={recycleHref(params, { dnc: "hide" })} className="underline underline-offset-2 hover:text-foreground">
                            skryť ich
                        </Link>
                    </>
                )}
            </p>
        </div>
    );
}
