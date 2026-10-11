export function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function field(value, key) { return record(value) ? value[key] : undefined; }
export function stringField(value, key) {
    const result = field(value, key);
    return typeof result === 'string' ? result : null;
}
export function arrayField(value, key) {
    const result = field(value, key);
    return Array.isArray(result) ? result : [];
}
export function parseJson(value) { return JSON.parse(value); }
