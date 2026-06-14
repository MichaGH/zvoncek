import { redirect } from "next/navigation";

// The old "Pridať firmu" form moved to the contacts feature.
export default function LegacyNewLeadPage() {
    redirect("/dashboard/contacts/new");
}
