import type { Page } from 'playwright';
export type GoogleSignInOptions = Readonly<{
    accountEmail?: string;
    diagnostic?: (event: Readonly<{
        event: string;
        step: string;
    }>) => void;
}>;
/** Recover a saved Google sign-in without storing credentials or handling challenges. */
export declare function createGoogleSignInRecovery(options?: GoogleSignInOptions): (page: Page) => Promise<void>;
