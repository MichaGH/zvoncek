"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string };

export default function MobileNav({ links }: { links: NavLink[] }) {
    const [open, setOpen] = useState(false);
    const pathname = usePathname();

    useEffect(() => {
        setOpen(false);
    }, [pathname]);

    return (
        <>
            {/* Burger / X button */}
            <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen((o) => !o)}
                aria-label={open ? "Zavrieť menu" : "Otvoriť menu"}
                aria-expanded={open}
                className="relative"
            >
                <Menu
                    className={cn(
                        "absolute h-5 w-5 transition-all duration-200",
                        open
                            ? "rotate-90 scale-75 opacity-0"
                            : "rotate-0 scale-100 opacity-100",
                    )}
                />
                <X
                    className={cn(
                        "absolute h-5 w-5 transition-all duration-200",
                        open
                            ? "rotate-0 scale-100 opacity-100"
                            : "-rotate-90 scale-75 opacity-0",
                    )}
                />
            </Button>

            {/* Backdrop — click outside to close */}
            <div
                className={cn(
                    "fixed inset-0 top-14 z-30 md:hidden transition-opacity duration-200",
                    open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
                )}
                onClick={() => setOpen(false)}
                aria-hidden
            />

            {/* Slide-down panel */}
            <div
                className="fixed inset-x-0 top-14 z-40 overflow-hidden border-b bg-background transition-[max-height,opacity] duration-200 ease-in-out md:hidden"
                style={{
                    maxHeight: open ? "calc(100dvh - 3.5rem)" : "0px",
                    opacity: open ? 1 : 0,
                    pointerEvents: open ? "auto" : "none",
                }}
            >
                <nav
                    className="flex flex-col gap-0.5 p-3"
                    onClick={() => setOpen(false)}
                >
                    {links.map((link) => (
                        <Link
                            key={link.href}
                            href={link.href}
                            className="rounded-md px-4 py-3.5 text-sm font-medium transition-colors hover:bg-accent"
                        >
                            {link.label}
                        </Link>
                    ))}
                </nav>
            </div>
        </>
    );
}
