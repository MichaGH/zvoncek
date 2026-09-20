import { redirect } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/lib/access/user";
import { OWNERSHIP_REASON_LABEL } from "@/lib/dictionaries";
import { businessDayMonth } from "@/lib/domain/businessTime";
import { can } from "@/lib/permissions";
import { getHandedOverHistory } from "@/lib/queries/pipeline";

// História obchodníka (wave 3 §7): obchody, ktoré odo mňa odišli (prevzaté, odovzdané, presunuté). Jeden riadok na
// obchod, bez odkazu na živý obchod – po odchode k nemu nemám prístup (D1d). Dopyt sám vynucuje, čo sem patrí.

export default async function HandedOverPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "deals.view")) redirect("/dashboard");

    const rows = await getHandedOverHistory(viewer.id);

    return (
        <DashboardPage>
            <DashboardPageHeader
                backHref="/dashboard/pipeline"
                backLabel="Späť na pipeline"
                title="História"
                description={`${rows.length} ${rows.length === 1 ? "obchod odišiel" : "obchodov odišlo"} odo mňa`}
            />
            {rows.length === 0 ? (
                <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">Žiadny obchod od teba zatiaľ neodišiel.</div>
            ) : (
                <>
                    <div className="flex flex-col gap-3 md:hidden">
                        {rows.map((r) => (
                            <div key={r.leadId} className="rounded-xl border bg-card p-4 text-sm shadow-sm">
                                <div className="flex items-baseline gap-2">
                                    <span className="text-xs text-muted-foreground tabular-nums">#{r.number}</span>
                                    <span className="truncate font-medium">{r.name}</span>
                                </div>
                                <p className="mt-1 text-muted-foreground">
                                    {OWNERSHIP_REASON_LABEL[r.reason]} {businessDayMonth(new Date(r.at))}
                                    {r.to ? ` · ${r.to}` : " · bez vlastníka"}
                                </p>
                                {r.note && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">„{r.note}“</p>}
                            </div>
                        ))}
                    </div>
                    <div className="hidden overflow-hidden rounded-lg border md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="pl-4">#</TableHead>
                                    <TableHead>Firma</TableHead>
                                    <TableHead>Čo sa stalo</TableHead>
                                    <TableHead>Komu</TableHead>
                                    <TableHead>Kto</TableHead>
                                    <TableHead className="pr-4">Poznámka</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((r) => (
                                    <TableRow key={r.leadId}>
                                        <TableCell className="pl-4 text-muted-foreground tabular-nums">{r.number}</TableCell>
                                        <TableCell className="font-medium">{r.name}</TableCell>
                                        <TableCell>
                                            {OWNERSHIP_REASON_LABEL[r.reason]} {businessDayMonth(new Date(r.at))}
                                        </TableCell>
                                        <TableCell>{r.to ?? "bez vlastníka"}</TableCell>
                                        <TableCell className="text-muted-foreground">{r.by ?? "—"}</TableCell>
                                        <TableCell className="max-w-xs truncate pr-4 text-muted-foreground">{r.note ?? "—"}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}
        </DashboardPage>
    );
}
