import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

// Čo smie prihlásený používateľ na obrazovke obchodov. POZOR: toto je LEN pomôcka pre vykresľovanie –
// každý príkaz si právo overuje sám (requireDealWork / requireDealManage) pod zámkom Lead riadku.
// Skryté tlačidlo nie je ochrana; ochrana je guard v príkaze.

export type DealCapabilities = {
    work: boolean; // ďalší krok, interakcia, cena, údaje, požiadavky
    manage: boolean; // stav, vlastník, typ projektu, WON, reopen, návrhy, vybavenie požiadaviek, hromadný presun
    seeOthers: boolean; // vidí aj cudzie obchody → zobrazí sa filter vlastníka a stĺpec „Rieši"
    createRequests: boolean;
    resolveRequests: boolean;
    manageDesigns: boolean;
    transferDeals: boolean;
};

export function dealCapabilities(viewer: Pick<AccessUser, "id" | "role">): DealCapabilities {
    const manage = can(viewer, "deals.manage");
    return {
        work: can(viewer, "deals.work") || manage,
        manage,
        seeOthers: can(viewer, "deals.viewAll") || can(viewer, "deals.viewTeam"),
        // Požiadavky podáva ten, kto ich sám nevybavuje (obchodník → manažér). Neskôr pribudne adresát (D-15).
        createRequests: can(viewer, "deals.work") && !can(viewer, "requests.resolve"),
        resolveRequests: can(viewer, "requests.resolve"),
        manageDesigns: manage,
        transferDeals: manage,
    };
}
