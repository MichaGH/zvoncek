"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

// Jedno okno, dve podoby (round 2, D-04): na telefóne vaul drawer zdola (funguje s klávesnicou, ťahaním, palcom),
// na PC klasický dialóg v strede – tam bottom sheet nedáva zmysel a zbytočne núti scrollovať.
//
// Zásady:
// - prvé vykreslenie je vždy mobilné (server aj klient), prepnutie sa udeje až po mount → žiadny hydration mismatch;
// - `data-vaul-no-drag` a `repositionInputs` sú vaul-only; v dialógovej vetve sa nepoužívajú (na obsahu neprekážajú);
// - obsah je ten istý JSX pre obe vetvy, aby sa nemohli rozísť.

const DESKTOP_QUERY = "(min-width: 768px)"; // = Tailwind md

function subscribe(onChange: () => void) {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const mql = window.matchMedia(DESKTOP_QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
}

export function useIsDesktop(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(DESKTOP_QUERY).matches : false),
        () => false, // server: mobilná vetva
    );
}

export default function ResponsiveSheet({
    open,
    onOpenChange,
    title,
    description,
    children,
    contentClassName,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    contentClassName?: string;
}) {
    const isDesktop = useIsDesktop();

    if (isDesktop) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className={cn("sm:max-w-3xl", contentClassName)}>
                    <DialogHeader className="pr-8">
                        <DialogTitle>{title}</DialogTitle>
                        {description ? <DialogDescription asChild><div>{description}</div></DialogDescription> : null}
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]">
                <DrawerHeader className="flex-none pb-2">
                    <DrawerTitle className="text-lg">{title}</DrawerTitle>
                    {description ? <DrawerDescription asChild><div className="text-sm">{description}</div></DrawerDescription> : null}
                </DrawerHeader>
                <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
            </DrawerContent>
        </Drawer>
    );
}
