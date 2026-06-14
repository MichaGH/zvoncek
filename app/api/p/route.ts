import prisma from "@/lib/db";
import { resolveTokenForIngest } from "@/lib/queries/tracking";
import { shortUa, looksLikeBot } from "@/lib/tracking/tokens";
import type { TrackedEventType } from "@/app/generated/prisma/enums";

// Public, anonymous tracking ingest. Visitors are not logged in.
// It must NEVER return lead data and always answers 204 so it can't be used
// to probe which tokens are valid.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function noContent() {
    return new Response(null, { status: 204, headers: CORS });
}

export function OPTIONS() {
    return noContent();
}

type Body = { p?: string; e?: string; d?: number };

async function parseBody(req: Request): Promise<Body> {
    // sendBeacon sends text/plain; fetch may send JSON. Both arrive as a JSON string.
    try {
        const text = await req.text();
        if (!text) return {};
        return JSON.parse(text) as Body;
    } catch {
        return {};
    }
}

function eventType(e: string | undefined): TrackedEventType | null {
    if (e === "view" || e === "page_view" || e === "PAGE_VIEW") return "PAGE_VIEW";
    if (e === "engaged" || e === "engaged_view" || e === "ENGAGED_VIEW")
        return "ENGAGED_VIEW";
    return null;
}

function clientIp(req: Request): string | null {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]?.trim() || null;
    return req.headers.get("x-real-ip");
}

export async function POST(req: Request) {
    const body = await parseBody(req);
    const token = typeof body.p === "string" ? body.p : "";
    const type = eventType(body.e);
    if (!token || !type) return noContent();

    const link = await resolveTokenForIngest(token);
    if (!link) return noContent();

    const ua = req.headers.get("user-agent");
    const ip = clientIp(req);
    const versionRow = link.versions[0];

    // Light dedup: skip an identical PAGE_VIEW from the same IP within 45s.
    if (type === "PAGE_VIEW" && ip) {
        const recent = await prisma.trackedEvent.findFirst({
            where: {
                linkId: link.id,
                type: "PAGE_VIEW",
                ip,
                occurredAt: { gte: new Date(Date.now() - 45_000) },
            },
            select: { id: true },
        });
        if (recent) return noContent();
    }

    const duration =
        typeof body.d === "number" && Number.isFinite(body.d)
            ? Math.max(0, Math.min(Math.round(body.d), 6 * 60 * 60_000))
            : null;

    try {
        await prisma.trackedEvent.create({
            data: {
                linkId: link.id,
                versionId: versionRow?.id ?? null,
                versionAtView: versionRow?.version ?? link.currentVersion,
                type,
                durationMs: duration,
                ip,
                uaShort: shortUa(ua),
                botFlag: looksLikeBot(ua),
            },
        });
    } catch {
        // Tracking must never throw back to the visitor.
    }
    return noContent();
}
