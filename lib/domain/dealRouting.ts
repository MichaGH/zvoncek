import type { LockedUser } from "@/lib/access/locks";
import { can } from "@/lib/permissions";

// Kto dostane obchod z pozitívneho prvého hovoru (plán §5.1). Volá sa pod zámkami:
// Team riadok volajúceho FOR SHARE → User riadky volajúceho a vedúceho FOR SHARE.
// 1. volajúci smie vlastniť obchody → volajúci
// 2. aktívny vedúci tímu volajúceho s deals.receive → vedúci
// 3. inak nepriradené (null)
export function resolveDealOwner(caller: LockedUser, leader: LockedUser | null | undefined): string | null {
    if (can(caller, "deals.receive")) return caller.id;
    if (caller.teamId && leader && !leader.deletedAt && can(leader, "deals.receive")) return leader.id;
    return null;
}
