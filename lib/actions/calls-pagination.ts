"use server";

import { getCallsBoard } from "@/lib/queries/calls";

export async function getMoreNew(cursor: string) {
    const board = await getCallsBoard(cursor);
    return {
        leads: board.fresh,
        hasMore: board.freshHasMore,
        nextCursor: board.freshNextCursor,
    };
}