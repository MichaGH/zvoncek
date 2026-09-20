"use client";

import InteractionSheet, { type InteractionTarget } from "@/components/pipeline/InteractionSheet";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";

const target: InteractionTarget = {
    id: "interaction-preview",
    number: 142,
    name: "Hotel Gerlach",
    phone: "+421 905 123 456",
    status: "ACTIVE",
    revision: 7,
    ownerId: "preview-user",
    noAnswerStreak: 2,
    price: 1285,
    priceNote: "web 850 · admin 249 · EN jazyk 186",
    nextActionKind: "CALL",
    nextActionNote: "Overiť, či videli ponuku",
    lastOffer: { text: "info + cenník", at: "2026-09-18T09:00:00.000Z" },
    lastActivity: { type: "CALL", outcome: "POSITIVE", note: null, at: "2026-09-19T09:00:00.000Z" },
    task: null,
    pending: [],
    outstanding: ["PRICE", "DESIGN"],
    clientPrice: { amount: "1180.00", channel: "EMAIL", sentOn: "2026-09-15T00:00:00.000Z" },
    gotPricelist: true,
};

const caps: DealCapabilities = {
    work: true,
    manage: false,
    seeOthers: false,
    askManager: true,
    resolver: false,
    manageDesigns: false,
    transferDeals: false,
};

export default function InteractionPreview() {
    return (
        <InteractionSheet
            target={target}
            caps={caps}
            viewerId="preview-user"
            onClose={() => {}}
            onRecordOffer={() => {}}
            onAsk={() => {}}
        />
    );
}
