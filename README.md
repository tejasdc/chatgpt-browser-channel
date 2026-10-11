# ChatGPT browser channel

Licensed under [MIT](LICENSE). This project is independent and is not affiliated with OpenAI.

A reference Node.js library and local command for an agent to submit a ChatGPT browser request, retain the exact send receipt, and observe the answer. The browser profile and request data stay outside this source repository. The package was extracted from an existing integration and can be embedded in a host that owns its request queue and account policy. The original host has not switched to this package.

## Terms and support boundary

[OpenAI's consumer Terms of Use](https://openai.com/policies/terms-of-use/) effective January 1, 2026 expressly prohibit automatically or programmatically extracting data or Output, and prohibit bypassing protective measures. This implementation reads undocumented authenticated ChatGPT endpoints to correlate sends and answers. The code and this notice do not grant permission or make that use compliant. Anyone considering operation or distribution must resolve that restriction with OpenAI. The supported upstream path for programmatic model access is the [OpenAI API](https://platform.openai.com/docs/overview), which has separate access and billing.

The package includes credential-free recovery through a Google session already saved in the operator's browser. It opens ChatGPT sign-in, selects an account supplied through private configuration, and verifies the resulting ChatGPT session. It never enters a password, handles a second factor, or solves a protective challenge; those conditions stop with a distinct operator-needed error. An embedding host can provide its own authorized recovery callback. Selectors and undocumented response fields can change at any time; there is no OpenAI support or availability guarantee.

## Install and run locally

The channel host requires Linux, Node 22 or newer, util-linux `flock`, and Chrome. This is the machine running the browser and package; remote agents can call its CLI over an existing secure shell route or use a separately authenticated bridge to its loopback HTTP interface. Clone this repository on the host, then run `npm ci && npm run build`. The built `dist/` files are also committed so Git dependency installs with `--ignore-scripts` work. Use `node dist/cli.js` from the clone, or run `npm link` once to install the `chatgpt-browser-channel` command on the host.

Launch Chrome as a nonroot desktop user with a dedicated private profile, then complete the first sign-in interactively in that Chrome window. The profile holds the Google and ChatGPT sessions and must be treated as a credential. Later, if ChatGPT signs out while the Google session remains available, the command can return through the saved account and verify the new ChatGPT session. It stops if Google requires a password or second factor, if a protective challenge appears, or if the account cannot be selected safely. For example, in a separate terminal:

```sh
install -d -m 700 "$HOME/.local/share/chatgpt-browser-channel/chrome"
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$HOME/.local/share/chatgpt-browser-channel/chrome" https://chatgpt.com/
```

Set `CHANNEL_BROWSER_URL=http://127.0.0.1:9222` and `CHANNEL_STATE_DIR` to a private directory. Set `CHANNEL_GOOGLE_ACCOUNT_EMAIL` privately when the browser has more than one saved Google account; the command has no account default. When set, that email is checked against every authenticated ChatGPT session before reading or sending, including sessions already signed in when the command starts. The CDP endpoint accepts only the literal loopback addresses `127.0.0.1` or `[::1]`; remote callers must reach the host through a separate secure channel. A separate `CHANNEL_PROFILE` can instead launch a sandboxed browser locally under a nonroot user. Never put a profile, state directory, account email, cookies, tokens, or conversation export in Git.

```sh
node dist/cli.js status
printf '%s' 'Summarize the attached report.' | node dist/cli.js ask --model pro --file ./report.pdf --json
node dist/cli.js receipt --id <request-uuid>
```

The lowercase request UUID is an idempotency key. Repeating one ID with a different prompt, model, or binding is refused. Older receipts did not record the requested model, so their IDs cannot be submitted again; they remain readable and their acknowledged answers resume automatically. A repeated new receipt joins the existing answer observation and model check. Receipts are written before dispatch; an ambiguous send is never automatically replayed. Inspect the original browser and receipt before deciding whether to send again under a new ID.

Existing version 1 request receipts and history checkpoints from the source integration remain readable when their respective state directories are passed unchanged. One process owns each state directory and browser endpoint/profile; a second process fails with `CHATGPT_OWNER_BUSY` or `CHATGPT_BROWSER_OWNER_BUSY`. Ownership uses a kernel file lock on an open descriptor; the kernel releases it on normal exit, SIGKILL, or host crash. The lock file remains on disk and needs no stale cleanup. This requires the `flock` command on the host. A CLI `ask` and `serve` must run sequentially against one browser.

For a loopback HTTP interface, set `CHANNEL_TOKEN` to a private random value of at least 24 characters and run `node dist/cli.js serve --port 8788`. All routes require `Authorization: Bearer <token>`: `POST /requests` accepts `{ "id": "<uuid>", "prompt": "...", "model": "pro" }` and returns 202 with a receipt path; `GET /requests/<uuid>` returns a state, explicit `terminal` boolean, error, and result without the original prompt; `GET /health` checks browser availability and current pending count. A repeated ID with the same prompt and model returns its existing receipt; changing either returns 409. At six pending requests, a new ID receives 429 with `channel_capacity`. The server binds only to `127.0.0.1`. It never exposes a public ingress by itself.

For a web application, its server-side route calls this loopback service and returns only the allowed request status to the browser. Keep `CHANNEL_TOKEN` in the web server's private environment; never send it to browser JavaScript. The web server owns user authentication, authorization, and any public ingress. No general CORS access is provided by this package.

If recovery stops, `CHATGPT_SIGNIN_ACCOUNT_REQUIRED` means the browser presented an account picker without a configured account; set `CHANNEL_GOOGLE_ACCOUNT_EMAIL` privately. `CHATGPT_SIGNIN_ACCOUNT_MISMATCH` means a signed-in ChatGPT account differs from that choice, and `CHATGPT_SIGNIN_ACCOUNT_UNCONFIRMED` means ChatGPT did not disclose enough identity to verify it. `CHATGPT_SIGNIN_NEEDS_OPERATOR` means a password, second factor, or unfamiliar sign-in page needs a person in that Chrome profile. `CHATGPT_CHALLENGE_NEEDS_OPERATOR` means a protective check needs a person. After that person completes sign-in, run `status` again. Inspect an existing request receipt before deciding whether a new request ID is safe; an uncertain send must never be replayed automatically.

## Library integration

```ts
import {ChatgptBrowser, ChatgptSubscription, ChatgptRefresh, createGoogleSignInRecovery} from 'chatgpt-browser-channel';

const browser = new ChatgptBrowser({
  endpoint: 'http://127.0.0.1:<port>',
  accountEmail: process.env.CHANNEL_GOOGLE_ACCOUNT_EMAIL,
  recover: createGoogleSignInRecovery({accountEmail: process.env.CHANNEL_GOOGLE_ACCOUNT_EMAIL})
});
const subscription = new ChatgptSubscription({directory: '<private-state>/runs', browser});
const refresh = new ChatgptRefresh({
  directory: '<private-state>/history', browser,
  sources: {import: async (name, content, scope) => { /* return imported identities */ return []; }}
});
```

`subscription.start(input)` returns an execution with a result promise, and `subscription.effect(id)` reads durable state. The input shape, message projection, send stages, and receipt format match the original implementation. The library exports browser, subscription, refresh, and their structural types. The host keeps ownership of request admission, routing, browser lifetime, account choice, and history indexing. The recovery callback receives a dedicated browser tab; the channel checks for an authenticated session after it returns. The included Google recovery uses only a saved browser session and an optional private account choice. A host can replace it with its own recovery callback. `personalModelPrefix` defaults to `personal:` and can be set by a host that already uses another private prefix, preserving its existing model list. A caller can still keep its own native session routes and durable request ownership.

`ChatgptRefresh` takes an exclusive lock on its history directory. A host embedding the library calls `await refresh.close()` during orderly shutdown; a process exit also releases the kernel lock. The subscription's `close()` waits for active observations before releasing receipt ownership.

The subscription continues acknowledged answers after restart and keeps uncertain dispatches for inspection. It verifies account scope, conversation branch, input text, and selected thinking level before acknowledging a send. A Pro request is checked against the model recorded for its final answer; one mismatch is retried in the same conversation. If that retry may have been sent before a crash but was not acknowledged, the result is uncertain and it is never sent again automatically. A second model mismatch is surfaced as a failure. Historical refresh keeps raw snapshots and indexed revisions separate, with incomplete coverage made explicit. Reads and resumed observations use bounded retries; an outage can still end uncertain. A password or second-factor prompt requires an operator; page and response changes can break the integration. None of these checks can make ChatGPT's undocumented interface stable or establish Terms permission.

`diagnostic` callbacks on the browser and subscription emit structured stage codes without prompt text; callers own alert delivery. The standalone command prints an actionable failure to stderr, and the local server offers health and request-state polling, but neither sends notifications. A host application must connect those signals to its own repair or user notice path.

## Development

`npm run check`, `npm run build`, and `npm run check:public` check types, compiled output, and tracked-source safety. Before any public release, also run `npm run check:public -- --history` and resolve every result. That check requires generic Git author and committer identity (`Contributors <contributors@users.noreply.github.com>`) throughout the public repository's history. Publishing is intentionally outside this repository's build scripts.
