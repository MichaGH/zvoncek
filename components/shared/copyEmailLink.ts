"use client";

import { displayUrl } from "@/lib/domain/designLinks";

// Do schránky vloží hotový odkaz do emailu: viditeľný text = čistá adresa, cieľ = sledovaný odkaz (round 2 §2c 5.8).
// Gmail/Outlook z text/html spravia klikateľný odkaz; čistý text (pre textové klienty) je samotný sledovaný odkaz.
// Obchodník tak sledovaný odkaz nikdy neotvára ani neskladá ručne.
export async function copyEmailLink(cleanUrl: string, tracked: string): Promise<boolean> {
    const text = displayUrl(cleanUrl);
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const html = `<a href="${escape(tracked)}">${escape(text)}</a>`;
    try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
            await navigator.clipboard.write([
                new ClipboardItem({
                    "text/html": new Blob([html], { type: "text/html" }),
                    "text/plain": new Blob([tracked], { type: "text/plain" }),
                }),
            ]);
            return true;
        }
        await navigator.clipboard.writeText(tracked);
        return true;
    } catch {
        return false; // schránka zablokovaná (napr. bez https)
    }
}
