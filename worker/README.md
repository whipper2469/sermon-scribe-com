# Sermon Worker — Deploy Instructions

## First time setup
```bash
cd worker
npm install -g wrangler
wrangler login
```

## Set your Anthropic API key (secret — never in code)
```bash
wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted
```

## Enable Workers AI on your account
In Cloudflare dashboard → Workers & Pages → your worker → Settings → Bindings
Add an AI binding named `AI`  (wrangler.toml already declares this)

## Deploy
```bash
wrangler deploy
```

## What it does
- Generates sermon text via Claude (claude-opus-4-6)
- Generates a biblical illustration image via Cloudflare Workers AI (Flux Schnell)
- Returns both in one response: `{ text, image }`
- Image is base64-encoded JPEG, embedded directly — no external storage needed
