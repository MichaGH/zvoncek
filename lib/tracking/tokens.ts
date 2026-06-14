import { randomBytes } from "node:crypto";

// URL-safe, unguessable token for a tracked link (~22 chars from 16 random bytes).
export function generateToken(): string {
    return randomBytes(16).toString("base64url");
}

const BOT_HINTS = [
    "bot",
    "crawler",
    "spider",
    "preview",
    "scan",
    "fetch",
    "monitor",
    "headless",
    "python",
    "curl",
    "wget",
    "axios",
    "go-http",
    "java/",
    "facebookexternalhit",
    "slackbot",
    "whatsapp",
    "telegrambot",
    "bingpreview",
    "googlebot",
    "proofpoint",
    "mimecast",
    "barracuda",
];

// Treat missing UA or known scanner/preview agents as bots. Flag, never drop.
export function looksLikeBot(ua: string | null | undefined): boolean {
    if (!ua) return true;
    const s = ua.toLowerCase();
    return BOT_HINTS.some((h) => s.includes(h));
}

// Coarse UA bucket "browser/os" – enough for bot heuristics, far less identifying than the raw UA.
export function shortUa(ua: string | null | undefined): string | null {
    if (!ua) return null;
    if (looksLikeBot(ua)) return "bot";
    const s = ua.toLowerCase();

    let browser = "other";
    if (s.includes("edg/")) browser = "edge";
    else if (s.includes("chrome/")) browser = "chrome";
    else if (s.includes("firefox/")) browser = "firefox";
    else if (s.includes("safari/")) browser = "safari";

    let os = "other";
    if (s.includes("windows")) os = "windows";
    else if (s.includes("mac os")) os = "mac";
    else if (s.includes("android")) os = "android";
    else if (s.includes("iphone") || s.includes("ipad")) os = "ios";
    else if (s.includes("linux")) os = "linux";

    return `${browser}/${os}`;
}
