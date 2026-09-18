import { redirect } from "next/navigation";

// Round 2 (D-01): obchody majú jednu obrazovku – /dashboard/pipeline. Tento súbor drží staré odkazy nažive,
// kým sa neprepíšu; potom sa dá zmazať.
export default async function ClientsRedirect({
    searchParams,
}: {
    searchParams: Promise<{ q?: string }>;
}) {
    const { q } = await searchParams;
    redirect(q ? `/dashboard/pipeline?q=${encodeURIComponent(q)}` : "/dashboard/pipeline");
}
