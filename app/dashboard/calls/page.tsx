import { getCallsBoard, getHandoffRecipient } from "@/lib/queries/calls";
import { requireUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";
import { redirect } from "next/navigation";
import CallQueue from "@/components/calls/CallQueue";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { History, Users } from "lucide-react";

export default async function CallsPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "calls.view")) redirect("/dashboard");

    const [board, recipient] = await Promise.all([getCallsBoard(viewer), getHandoffRecipient(viewer)]);
    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Volania"
                description={`Voľných v spoločnej fronte: ${board.poolCount}`}
                actions={
                    <>
                        {can(viewer, "calls.assign") && (
                            <Button asChild variant="outline" size="sm">
                                <Link href="/dashboard/calls/assignments">
                                    <Users className="mr-1.5 h-4 w-4" />
                                    Priradenia
                                </Link>
                            </Button>
                        )}
                        <Button asChild variant="outline" size="sm">
                            <Link href="/dashboard/calls/history">
                                <History className="mr-1.5 h-4 w-4" />
                                História
                            </Link>
                        </Button>
                        <RefreshButton />
                    </>
                }
            />
            <CallQueue board={board} recipientPreview={recipient?.name ?? null} canClaim={can(viewer, "calls.claim")} />
        </DashboardPage>
    );
}
