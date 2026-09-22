"use client";

import type { ReactNode } from "react";
import {
    BadgeEuro,
    Check,
    Info,
    PackageCheck,
    Palette,
    PanelsTopLeft,
    ReceiptText,
    ScanSearch,
    type LucideIcon,
} from "lucide-react";
import type { RequestContent } from "@/app/generated/prisma/enums";
import { REQUEST_CONTENT_LABEL, REQUEST_CONTENTS } from "@/lib/domain/clientRequests";
import { cn } from "@/lib/utils";

// Karta výberu – rovnaký vizuálny jazyk v akčnom okne obchodu aj v /calls: ikona, jeden jasný názov, krátke
// vysvetlenie a viditeľný stav výberu. Na telefóne je karta horizontálna a ľahko trafiteľná palcom; na PC sa skladajú po dve.
const CARD =
    "group flex min-h-[64px] w-full items-center gap-3 rounded-xl border bg-background px-3.5 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CARD_ON = "border-primary/70 bg-primary/[0.06] text-foreground shadow-sm ring-1 ring-primary/20";
const CARD_OFF = "hover:border-primary/30 hover:bg-muted/50";

// Farba ikony nesie význam a je jediné miesto, kde je karta farebná – text a rámik ostávajú neutrálne, takže sa
// obrazovka nerozpadne na dúhu. Jeden odtieň na jeden zmysel: modrá = kontakt / informácia, zelená = peniaze,
// fialová = návrh, jantárová = pozor / čaká sa, červená = koniec, sivá = neutrálne.
export type Tone = "blue" | "teal" | "green" | "violet" | "orange" | "rose" | "slate";

// Plná farba na dlaždici, biela ikona. Odtiene sú tie, ktoré používa shadcn vo svojich témach; sú volené tak, aby
// biela na nich mala dosť kontrastu aj v svetlom aj v tmavom režime.
const TONE: Record<Tone, string> = {
    blue: "bg-blue-500 text-white",
    teal: "bg-teal-600 text-white",
    green: "bg-emerald-600 text-white",
    violet: "bg-violet-500 text-white",
    orange: "bg-orange-500 text-white",
    rose: "bg-rose-500 text-white",
    slate: "bg-slate-500 text-white dark:bg-slate-600",
};

export function OptionCard({
    label,
    hint,
    icon: Icon,
    tone = "slate",
    on = false,
    disabled,
    onClick,
    role,
}: {
    label: string;
    hint?: string | null;
    icon?: LucideIcon;
    tone?: Tone;
    on?: boolean;
    disabled?: boolean;
    onClick: () => void;
    role?: "radio" | "checkbox";
}) {
    return (
        <button
            type="button"
            data-vaul-no-drag
            {...(role ? { role, "aria-checked": on } : {})}
            disabled={disabled}
            onClick={onClick}
            className={cn(CARD, on ? CARD_ON : CARD_OFF, disabled && "pointer-events-none opacity-50")}
        >
            {Icon && (
                <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", TONE[tone])}>
                    <Icon className="h-[18px] w-[18px]" />
                </span>
            )}
            <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm font-medium leading-5">{label}</span>
                {hint && <span className="block text-xs font-normal leading-4 text-muted-foreground">{hint}</span>}
            </span>
            {role && (
                <span
                    aria-hidden
                    className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center border transition-colors",
                        role === "radio" ? "rounded-full" : "rounded-md",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30 bg-background",
                    )}
                >
                    {on && <Check className="h-3.5 w-3.5" />}
                </span>
            )}
        </button>
    );
}

export function InfoPanel({
    icon: Icon = Info,
    children,
    tone = "neutral",
}: {
    icon?: LucideIcon;
    children: ReactNode;
    tone?: "neutral" | "warning";
}) {
    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded-xl p-3 text-sm",
                tone === "warning" ? "border border-amber-500/35 bg-amber-500/10" : "bg-muted/55",
            )}
        >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "warning" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export const REQUEST_CARD: Record<RequestContent, { icon: LucideIcon; hint: string; tone: Tone }> = {
    INFO: { icon: PanelsTopLeft, hint: "Kto sme a ukážky našej práce", tone: "blue" },
    PRICELIST: { icon: ReceiptText, hint: "Všeobecný prehľad cien", tone: "teal" },
    PRICE: { icon: BadgeEuro, hint: "Cena pripravená pre tohto klienta", tone: "green" },
    DESIGN: { icon: Palette, hint: "Grafický návrh webu", tone: "violet" },
    REVIEW: { icon: ScanSearch, hint: "Čo sa dá zlepšiť na ich webe", tone: "orange" },
};

// „Čo chcú" – päť kariet, na každom kroku (akčné okno obchodu aj prvý hovor v /calls) rovnako: rovnaká výška
// (`auto-rows-fr`), na telefóne jeden stĺpec, na PC dva.
export function RequestContentPicker({
    value,
    onToggle,
    disabled,
    note = "Môžeš vybrať viac možností. Ďalší krok je poslať ich – nič iné sa už nevyberá.",
}: {
    value: readonly RequestContent[];
    onToggle: (content: RequestContent) => void;
    disabled?: boolean;
    note?: string;
}) {
    return (
        <div className="space-y-2">
            <InfoPanel icon={PackageCheck}>{note}</InfoPanel>
            <div className="grid auto-rows-fr gap-2 md:grid-cols-2">
                {REQUEST_CONTENTS.map((content) => (
                    <OptionCard
                        key={content}
                        label={REQUEST_CONTENT_LABEL[content]}
                        hint={REQUEST_CARD[content].hint}
                        icon={REQUEST_CARD[content].icon}
                        tone={REQUEST_CARD[content].tone}
                        role="checkbox"
                        on={value.includes(content)}
                        disabled={disabled}
                        onClick={() => onToggle(content)}
                    />
                ))}
            </div>
        </div>
    );
}
