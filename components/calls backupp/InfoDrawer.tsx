"use client";

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { QueueLead } from "@/lib/queries/calls";
import { Phone, Globe, StickyNote, History } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function InfoDrawer({ lead, onClose }: { lead: QueueLead | null; onClose: () => void }) {
    if (!lead) return <Drawer open={false} />;
    const L = lead;
    const name = L.companyName ?? L.website ?? "—";

    return (
        <Drawer open={!!lead} onOpenChange={(o) => !o && onClose()}>
            <DrawerContent>
                <div className="mx-auto w-full max-w-md">
                    <DrawerHeader>
                        <DrawerTitle className="flex items-center gap-2">
                            <span className="text-muted-foreground tabular-nums">#{L.number}</span>
                            {name}
                        </DrawerTitle>
                        <DrawerDescription className="sr-only">Detaily firmy</DrawerDescription>
                    </DrawerHeader>

                    <div className="space-y-3 px-4 pb-6">
                        {L.phone && (
                            <Row icon={<Phone className="h-4 w-4" />}>
                                <a href={`tel:${L.phone.replace(/\s/g, "")}`} className="font-medium tabular-nums">{L.phone}</a>
                            </Row>
                        )}
                        {L.website && (
                            <Row icon={<Globe className="h-4 w-4" />}>
                                <span className="break-all">{L.website}</span>
                            </Row>
                        )}
                        {L.attempts > 0 && (
                            <Row icon={<History className="h-4 w-4" />}>
                                <span>{L.attempts}× volané{L.lastAttemptAt ? "" : ""}</span>
                            </Row>
                        )}
                        {L.note ? (
                            <div className="rounded-lg border bg-muted/30 p-3">
                                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                    <StickyNote className="h-3.5 w-3.5" />Poznámka
                                </div>
                                <p className="text-sm">{L.note}</p>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">Žiadna poznámka.</p>
                        )}

                        <Button asChild variant="outline" className="w-full">
                            <Link href={`/dashboard/leads/${L.id}`}>Otvoriť celý detail</Link>
                        </Button>
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{icon}</span>
            {children}
        </div>
    );
}