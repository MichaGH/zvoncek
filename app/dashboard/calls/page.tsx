import { getCallsBoard } from "@/lib/queries/calls";
import CallQueue from "@/components/calls/CallQueue";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { History } from "lucide-react";

export default async function CallsPage() {
    const board = await getCallsBoard();
    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Volania"
                description="Prvý kontakt s firmami"
                actions={
                    <>
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
            <CallQueue board={board} />
        </DashboardPage>
    );
}
