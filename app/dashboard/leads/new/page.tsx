import prisma from "@/lib/db";
import AddLeadForm from "@/components/leads/AddLeadForm";
import QueueList from "@/components/leads/QueueList";


export default async function NewLeadPage() {
    const queue = await prisma.lead.findMany({
        where: { status: "NEW" },
        select: { id: true, number: true, companyName: true, website: true, phone: true, note: true },
        orderBy: { createdAt: "desc" }, // najnovšie hore – N vidí, čo práve pridal
    });

    return (
        <main className="mx-auto max-w-md px-4 py-8">
            <h1 className="mb-1 text-2xl font-semibold tracking-tight">Pridať firmu</h1>
            <p className="mb-6 text-sm text-muted-foreground">
                Meno alebo web + číslo. Enter pridá a ide sa ďalej.
            </p>
            <AddLeadForm />
            <QueueList leads={queue} />
        </main>
    );
}