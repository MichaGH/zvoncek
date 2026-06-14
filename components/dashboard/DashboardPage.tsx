import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// All dashboard pages share the same outer container so the header (title,
// description, actions) starts at the same horizontal position on every page.
// Page content can opt into a narrower width via <DashboardContent>.
export function DashboardPage({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <main className={cn("mx-auto w-full max-w-6xl px-4 py-8 sm:px-6", className)}>
            {children}
        </main>
    );
}

type ContentWidth = "full" | "wide" | "default" | "narrow";

const CONTENT_WIDTH: Record<ContentWidth, string> = {
    full: "",
    wide: "max-w-5xl",
    default: "max-w-4xl",
    narrow: "max-w-3xl",
};

// Optional inner wrapper to keep working content from stretching the full header
// width on pages where that looks bad (e.g. detail pages).
export function DashboardContent({
    children,
    width = "full",
    className,
}: {
    children: React.ReactNode;
    width?: ContentWidth;
    className?: string;
}) {
    return <div className={cn("w-full", CONTENT_WIDTH[width], className)}>{children}</div>;
}

export function DashboardPageHeader({
    title,
    description,
    backHref,
    backLabel = "Späť",
    badge,
    actions,
    children,
}: {
    title: React.ReactNode;
    description?: React.ReactNode;
    backHref?: string;
    backLabel?: string;
    badge?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <header className="mb-6 space-y-4">
            {backHref && <BackLink href={backHref} label={backLabel} />}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                        {badge}
                    </div>
                    {description && (
                        <p className="text-sm text-muted-foreground">{description}</p>
                    )}
                </div>
                {actions && (
                    <div className="flex shrink-0 items-center gap-2">{actions}</div>
                )}
            </div>
            {children}
        </header>
    );
}

function BackLink({ href, label }: { href: string; label: string }) {
    return (
        <Link
            href={href}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
            <ArrowLeft className="h-4 w-4" />
            {label}
        </Link>
    );
}
