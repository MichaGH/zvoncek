import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fmtAgo(iso: string | null) {
    if (!iso) return null;
    const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);
    if (h < 1) return "pred chvíľou";
    if (h < 24) return `pred ${h} h`;
    return `pred ${Math.floor(h / 24)} dňami`;
}
