import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type Width = "default" | "wide" | "narrow";

const WIDTH_CLASS: Record<Width, string> = {
    narrow: "max-w-3xl",
    default: "max-w-5xl",
    wide: "max-w-6xl",
};

export function DashboardPage({
    children,
    width = "default",
    className,
}: {
    children: React.ReactNode;
    width?: Width;
    className?: string;
}) {
    return (
        <main className={cn("mx-auto w-full px-4 py-8", WIDTH_CLASS[width], className)}>
            {children}
        </main>
    );
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
            {backHref && (
                <BackLink href={backHref} label={backLabel} />
            )}
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
