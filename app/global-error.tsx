"use client";

import { useEffect } from "react";

// global-error nahrádza celý root layout (vrátane <html>/<body>), keď spadne
// samotný layout. Tailwind/globals.css tu nie sú dostupné → inline štýly.
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <html lang="sk" style={{ colorScheme: "light dark" }}>
            <body
                style={{
                    margin: 0,
                    minHeight: "100dvh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                    background: "#0a0a0a",
                    color: "#fafafa",
                }}
            >
                <div style={{ textAlign: "center", padding: "1rem", maxWidth: 360 }}>
                    <h1 style={{ fontSize: "1.125rem", fontWeight: 500, margin: "0 0 0.5rem" }}>
                        Aplikácia spadla
                    </h1>
                    <p style={{ fontSize: "0.875rem", color: "#a1a1a1", margin: "0 0 1.25rem", lineHeight: 1.6 }}>
                        Obnov stránku. Ak problém pretrváva, kontaktuj správcu.
                    </p>
                    <button
                        onClick={reset}
                        style={{
                            padding: "0.5rem 1rem",
                            borderRadius: 8,
                            border: "1px solid #3a3a3a",
                            background: "#fafafa",
                            color: "#0a0a0a",
                            fontSize: "0.875rem",
                            cursor: "pointer",
                        }}
                    >
                        Obnoviť
                    </button>
                </div>
            </body>
        </html>
    );
}
