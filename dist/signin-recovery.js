const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Recover a saved Google sign-in without storing credentials or handling challenges. */
export function createGoogleSignInRecovery(options = {}) {
    const note = (step) => { try {
        options.diagnostic?.({ event: 'chatgpt_signin_step', step });
    }
    catch { } };
    const signedIn = async (page) => {
        if (new URL(page.url()).hostname !== 'chatgpt.com')
            return false;
        return page.evaluate(async () => {
            const response = await fetch('/api/auth/session', { credentials: 'include' }).catch(() => null);
            if (!response?.ok)
                return { authenticated: false, email: null };
            const session = await response.json().catch(() => null);
            return { authenticated: !!session?.accessToken, email: session?.user?.email ?? null };
        }).then(result => {
            if (!result.authenticated)
                return false;
            if (options.accountEmail) {
                if (!result.email)
                    throw new Error('CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED');
                if (result.email.toLowerCase() !== options.accountEmail.toLowerCase())
                    throw new Error('CHATGPT_SIGNIN_ACCOUNT_MISMATCH');
            }
            return true;
        }, () => false);
    };
    const challenged = async (page) => {
        const title = await page.title().catch(() => '');
        return /just a moment|checking your browser/i.test(title) || page.url().includes('/cdn-cgi/challenge');
    };
    return async (page) => {
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' }).catch(() => { });
        for (const deadline = Date.now() + 90_000; Date.now() < deadline; await pause(1500)) {
            if (await signedIn(page)) {
                note('authenticated');
                return;
            }
            if (await challenged(page))
                throw new Error('CHATGPT_CHALLENGE_NEEDS_OPERATOR');
            let url;
            try {
                url = new URL(page.url());
            }
            catch {
                throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
            }
            if (url.hostname === 'chatgpt.com') {
                if (!url.pathname.startsWith('/auth')) {
                    note('open-login');
                    await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' }).catch(() => { });
                    continue;
                }
                const cookies = page.getByRole('button', { name: 'Reject non-essential' }).first();
                if (await cookies.isVisible().catch(() => false))
                    await cookies.click({ timeout: 5000 }).catch(() => { });
                const google = page.getByRole('button', { name: 'Continue with Google' }).first();
                if (await google.isVisible().catch(() => false)) {
                    note('continue-with-google');
                    await google.click({ timeout: 10_000 }).catch(() => { });
                    continue;
                }
            }
            else if (url.hostname === 'accounts.google.com') {
                if (await page.locator('input[type=password]').isVisible().catch(() => false))
                    throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
                const words = await page.locator('body').innerText().catch(() => '');
                if (/verify it.s you|2-step|confirm it.s you|use your passkey/i.test(words))
                    throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
                const account = options.accountEmail ? page.getByText(options.accountEmail, { exact: true }).first() : null;
                if (account && await account.isVisible().catch(() => false)) {
                    note('choose-saved-account');
                    await account.click({ timeout: 10_000 });
                    continue;
                }
                if (await page.getByRole('textbox', { name: /email or phone/i }).isVisible().catch(() => false))
                    throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
                const proceed = page.getByRole('button', { name: /^(Continue|Allow)$/ }).first();
                if (await proceed.isVisible().catch(() => false)) {
                    note('confirm-saved-account');
                    await proceed.click({ timeout: 10_000 });
                    continue;
                }
                if (!options.accountEmail && /choose an account/i.test(words))
                    throw new Error('CHATGPT_SIGNIN_ACCOUNT_REQUIRED');
            }
            else
                throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
        }
        throw new Error('CHATGPT_SIGNIN_NEEDS_OPERATOR');
    };
}
