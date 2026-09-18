// Odkazy na návrh – jedno miesto pre čistú adresu a sledovaný odkaz (?p=token). Bez DB, dá sa importovať aj z klienta.

export function normalizeUrl(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Čistá adresa na zobrazenie v emaile: bez protokolu a koncového lomítka („smrek1.thegrandpoints.com").
export function displayUrl(url: string): string {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function trackedUrl(targetUrl: string, token: string): string {
    const base = normalizeUrl(targetUrl);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}p=${token}`;
}
