import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}



export function inHours(h: number) { const d = new Date(); d.setHours(d.getHours() + h); return d.toISOString(); }
export function tomorrow9() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); }
export function inDays(days: number) { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.toISOString(); }
export function inMonths(m: number) { const d = new Date(); d.setMonth(d.getMonth() + m); d.setHours(9, 0, 0, 0); return d.toISOString(); }