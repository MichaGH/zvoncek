import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

// Čo smie prihlásený používateľ na obrazovke obchodov. POZOR: toto je LEN pomôcka pre vykresľovanie –
// každý príkaz si právo overuje sám (requireDealWork / requireDealManage) pod zámkom Lead riadku.
// Skryté tlačidlo nie je ochrana; ochrana je guard v príkaze.

export type DealCapabilities = {
    work: boolean; // ďalší krok, interakcia, cena, údaje, „Požiadať manažéra"
    manage: boolean; // stav, vlastník, typ projektu, WON, reopen, návrhy, prevzatie, hromadný presun
    seeOthers: boolean; // vidí aj cudzie obchody → zobrazí sa filter vlastníka a stĺpec „Rieši"
    askManager: boolean; // môže požiadať manažéra (úloha) – obchodník, nikdy manažér na vlastnom obchode (D7)
    resolver: boolean; // vybavuje úlohy („Pre mňa") – manažér / admin
    manageDesigns: boolean;
    transferDeals: boolean;
};

export function dealCapabilities(viewer: Pick<AccessUser, "id" | "role">): DealCapabilities {
    const manage = can(viewer, "deals.manage");
    return {
        work: can(viewer, "deals.work") || manage,
        manage,
        seeOthers: can(viewer, "deals.viewAll") || can(viewer, "deals.viewTeam"),
        // Úlohu zadáva ten, kto ju sám nevybavuje (obchodník → manažér); telesales obchody nemajú (wave 3, D7/D9).
        askManager: can(viewer, "deals.work") && !can(viewer, "requests.resolve"),
        resolver: can(viewer, "requests.resolve") && manage,
        manageDesigns: manage,
        transferDeals: manage,
    };
}
