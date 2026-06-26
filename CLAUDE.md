# CLAUDE.md — lemon-pitch-server

## What This Is

A standalone Express server that powers the Lemon Pitch Console (Billy's pitch presentation app). It does two things:

1. **ElevenLabs TTS proxy** — converts pitch text to audio using ElevenLabs
2. **Pitch roster API** — serves enriched pitch objects to the front-end, sorted by `pendingSince` to mirror the Dev Gate queue order

This server is **independent of the main Paperclip fork**. It lives in its own subdirectory and has its own git history on `master`.

---

## CRITICAL: Deployment Is on Hostinger VPS, NOT Railway

**Ignore `railway.toml`.** It is a leftover artifact from an early prototype that was never cleaned up. This server has **never run on Railway** in production.

**Production URL:** `https://pitches-api.billyrovzar.com`

**Deployed on:** Hostinger VPS (`ssh root@187.124.251.98`) via **pm2** (process manager).

**Source on VPS:** `/root/lemon-paperclip-dev/lemon-pitch-server/`

**Git branch deployed:** `master` (NOT `lemon-virtual-studios` — this server tracks its own branch)

---

## Deploy Command

```bash
ssh root@187.124.251.98
cd /root/lemon-paperclip-dev/lemon-pitch-server && git pull origin master && pm2 restart pitch-api
```

After deploy, verify:
```bash
curl https://pitches-api.billyrovzar.com/pitches/roster | head -c 300
```

The first project in the roster should be the one with the latest `pendingSince` date (Dev Gate sort order).

---

## PM2 Process

| Field | Value |
|---|---|
| Process name | `pitch-api` |
| Start command | `node server.js` |
| Working dir | `/root/lemon-paperclip-dev/lemon-pitch-server` |

Useful pm2 commands:
```bash
pm2 list                    # show all processes and status
pm2 logs pitch-api          # tail logs
pm2 restart pitch-api       # restart after deploy
```

---

## Environment Variables

The server loads `/root/lemon-paperclip-dev/lemon-pitch-server/.env.local` automatically at startup (built-in parser, no npm package needed). This file lives on the VPS only, is NOT committed to git, and is the canonical place for secrets.

**Create or update the file on VPS:**
```bash
cat > /root/lemon-paperclip-dev/lemon-pitch-server/.env.local << 'EOF'
ELEVENLABS_API_KEY=your_key_here
PAPERCLIP_API_KEY=your_paperclip_jwt_here
EOF
```

Then `pm2 restart pitch-api` to pick it up.

| Variable | Purpose | Default |
|---|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs TTS API key (REQUIRED for audio) | none |
| `PAPERCLIP_API_KEY` | Paperclip board user JWT for reading project data | none |
| `PAPERCLIP_API_URL` | Paperclip API base URL | `https://paperclip.billyrovzar.com` |
| `PAPERCLIP_COMPANY_ID` | Lemon company ID | `ff52ad91-...` |
| `PORT` | HTTP port | `3000` |

If `ELEVENLABS_API_KEY` is missing, the `/pitches/:id/audio` endpoint returns `503 "ElevenLabs API key not configured"` and the Pitch Terminal shows "Audio unavailable" for every pitch.

---

## Key Files

| File | Purpose |
|---|---|
| `server.js` | Main Express server |
| `pitchParser.js` | Parses raw Paperclip issue documents into pitch objects |
| `pitchScripts.json` | Pre-bundled pitch scripts (baked at build time) |
| `pitchMapping.json` | Hardcoded project-ID to pitch-number fallback map |
| `audio-cache/` | On-disk TTS audio cache (created at runtime) |
| `railway.toml` | **Ignore** — stale artifact, not used |

---

## Sort Order

Pitches are sorted by `pendingSince` descending (most recently added to the Dev Gate queue first). This mirrors the Dev Gate board order so Billy sees the same sequence in both places. The sort field was changed from `createdAt` → `pendingSince` in commit `59472b5` (LEMA-5479/5539).
