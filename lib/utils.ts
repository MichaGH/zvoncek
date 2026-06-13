import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function inHours(h: number) { const d = new Date(); d.setHours(d.getHours() + h); return d.toISOString(); }
export function tomorrow9() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); }
export function inDays(days: number) { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.toISOString(); }
export function inMonths(m: number) { const d = new Date(); d.setMonth(d.getMonth() + m); d.setHours(9, 0, 0, 0); return d.toISOString(); }


export function fmtScheduled(iso: string | null) {
    if (!iso) return null;
    const d = new Date(iso);
    const now = new Date();
    const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d <= now) return "teraz";
    if (d.toDateString() === now.toDateString()) return `dnes ${time}`;
    const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
    if (d.toDateString() === tmr.toDateString()) return `zajtra ${time}`;
    return `${d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" })} ${time}`;
}

export function fmtAgo(iso: string | null) {
    if (!iso) return null;
    const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);
    if (h < 1) return "pred chvíľou";
    if (h < 24) return `pred ${h} h`;
    return `pred ${Math.floor(h / 24)} dňami`;
}
