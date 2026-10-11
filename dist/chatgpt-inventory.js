import { chatgptDigest } from './chatgpt-content.js';
import { record } from './provider-values.js';
export class ChatgptSourceReadError extends Error {
    raw;
    constructor(code, raw) {
        super(code);
        this.raw = raw;
    }
}
export function readChatgptInventory(raw, offset, limit) {
    if (!record(raw) || !Array.isArray(raw['items']) || raw['offset'] !== offset || raw['limit'] !== limit ||
        !Number.isSafeInteger(raw['total']) || Number(raw['total']) < offset + raw['items'].length || raw['items'].length > limit)
        throw new ChatgptSourceReadError('CHATGPT_INVENTORY_INVALID', raw);
    const items = raw['items'].map(item => {
        if (!record(item) || typeof item['id'] !== 'string' || !/^[a-zA-Z0-9-]+$/.test(item['id']))
            throw new ChatgptSourceReadError('CHATGPT_INVENTORY_IDENTITY_MISSING', raw);
        // Optional presentation flags vary between cached pages; raw pages remain retained separately.
        const revision = chatgptDigest(JSON.stringify(['id', 'title', 'create_time', 'update_time', 'latest_assistant_turn_created_at', 'current_node', 'gizmo_id', 'is_archived'].map(key => item[key] ?? null)));
        return { id: item['id'], revision };
    });
    if (new Set(items.map(item => item.id)).size !== items.length)
        throw new ChatgptSourceReadError('CHATGPT_INVENTORY_CHANGED', raw);
    // The live service reports offset + limit + 1 until the last page, not the account total.
    const nextOffset = items.length === limit ? offset + items.length : null;
    if (nextOffset === null && raw['total'] !== offset + items.length)
        throw new ChatgptSourceReadError('CHATGPT_INVENTORY_INCOMPLETE', raw);
    return { items, nextOffset, reportedTotal: Number(raw['total']), raw };
}
