export declare function record(value: unknown): value is Record<string, unknown>;
export declare function field(value: unknown, key: string): unknown;
export declare function stringField(value: unknown, key: string): string | null;
export declare function arrayField(value: unknown, key: string): readonly unknown[];
export declare function parseJson(value: string): unknown;
