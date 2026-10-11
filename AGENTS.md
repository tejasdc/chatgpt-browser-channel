# ChatGPT browser channel

This project packages a browser adapter, durable request receipts, and history refresh. The host owns request admission, browser lifetime, account policy, and any recovery callback.

Read [README.md](README.md) for setup, API, reliability limits, and the OpenAI Terms restriction. Run `npm run check`, `npm run build`, and `npm run check:public` before committing.
The included saved-Google-session recovery takes its account choice from private configuration and stops at passwords, second factors, and protective challenges; the README owns that protocol. Keep profiles, tokens, conversation data, and operator-specific recovery outside this repository.
