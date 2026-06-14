import Script from "next/script";
import { notFound } from "next/navigation";

// Dev-only stand-in for a real proposal page, so you can test the snippet in a browser.
// Open: /dev/proposal?p=YOUR_TOKEN  (get a token from `npm run seed:tracking`).
export const dynamic = "force-dynamic";

export default async function DevProposalPage({
    searchParams,
}: {
    searchParams: Promise<{ p?: string }>;
}) {
    if (process.env.NODE_ENV === "production") notFound();
    const { p } = await searchParams;

    return (
        <main
            style={{
                maxWidth: 640,
                margin: "40px auto",
                padding: 16,
                fontFamily: "system-ui, sans-serif",
                lineHeight: 1.6,
            }}
        >
            <h1>Dev proposal — test tracking</h1>
            <p>
                Toto je testovacia „proposal&quot; stránka. Snippet <code>/p.js</code> sa
                načíta a pošle event na <code>/api/p</code>.
            </p>
            <p>
                Token:{" "}
                <strong>{p ?? "(žiadny — pridaj ?p=TOKEN do URL)"}</strong>
            </p>
            <ol>
                <li>
                    Spusti <code>npx prisma studio</code> a otvor tabuľku{" "}
                    <code>TrackedEvent</code>.
                </li>
                <li>Po načítaní tejto stránky pribudne <code>PAGE_VIEW</code>.</li>
                <li>
                    Ostaň ~8 sekúnd alebo scrolluj nadol → pribudne{" "}
                    <code>ENGAGED_VIEW</code>.
                </li>
            </ol>
            <div style={{ height: 1400 }} aria-hidden />
            <p>↓ Scrolluj sem — to spustí „engaged&quot; event.</p>
            {p ? <Script src="/p.js" data-p={p} strategy="afterInteractive" /> : null}
        </main>
    );
}
