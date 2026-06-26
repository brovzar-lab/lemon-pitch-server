'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { parsePitchDocument } = require('./pitchParser');

// Pre-bundled pitch scripts (full text, pre-parsed at build time)
const BUNDLED_SCRIPTS = require('./pitchScripts.json');

// ---------------------------------------------------------------------------
// Load .env.local if present — lets VPS store ELEVENLABS_API_KEY etc.
// without committing secrets to git. Keys already in process.env win.
// ---------------------------------------------------------------------------
try {
  const envPath = path.join(__dirname, '.env.local');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) return;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    });
  }
} catch (_) {}

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || 'https://paperclip.billyrovzar.com';
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || 'ff52ad91-250b-4d9d-a2ee-1d24b65ec3e8';
const PITCH_DOC_ISSUE_ID = '6159de20-0610-4c00-95fd-fd842e3af93e';

// Default voice: Charlie — Deep, Confident, Energetic
const DEFAULT_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';
const ELEVENLABS_MODEL = 'eleven_turbo_v2_5';

const AUDIO_CACHE_DIR = path.join(__dirname, 'audio-cache');
if (!fs.existsSync(AUDIO_CACHE_DIR)) fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory pitch store
// ---------------------------------------------------------------------------
let pitchStore = []; // Array of enriched pitch objects keyed by projectId

// Load hardcoded mapping as fallback
const HARDCODED_MAPPING = require('./pitchMapping.json');

async function loadPitches() {
  // Start from bundled scripts (pre-parsed at build time, always available)
  const scriptsByNumber = {};
  for (const s of BUNDLED_SCRIPTS) {
    scriptsByNumber[s.pitchNumber] = s;
  }

  // Attempt to refresh from live Paperclip API (updates devStage/billyVerdict, re-parses scripts)
  try {
    const res = await fetch(
      `${PAPERCLIP_API_URL}/api/issues/${PITCH_DOC_ISSUE_ID}/documents/pitch-session`,
      { headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` }, timeout: 8000 }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const livePitches = parsePitchDocument(doc.body);
    for (const p of livePitches) {
      scriptsByNumber[p.pitchNumber] = { ...scriptsByNumber[p.pitchNumber], ...p };
    }
    console.log(`Refreshed ${livePitches.length} pitches from Paperclip API.`);
  } catch (err) {
    console.log(`Using bundled pitch scripts (Paperclip API unavailable: ${err.message})`);
  }

  // Merge with projectId mapping and live devStage/verdict from projects
  pitchStore = HARDCODED_MAPPING.map((entry) => {
    const scripts = scriptsByNumber[entry.pitchNumber] || {};
    return {
      pitchNumber: entry.pitchNumber,
      title: entry.title,
      projectId: entry.projectId,
      format: scripts.format || entry.format || '',
      platform: scripts.platform || '',
      genre: scripts.genre || '',
      cleanScript: scripts.cleanScript || '',
      logline: scripts.logline || '',
      comps: scripts.comps || '',
      devStage: entry.devStage,
      billyVerdict: entry.billyVerdict,
      createdAt: entry.createdAt || null,
      pendingSince: entry.pendingSince || null,
    };
  });

  console.log(`Pitch store ready: ${pitchStore.length} pitches.`);
}

// ---------------------------------------------------------------------------
// Verdict mapping
// ---------------------------------------------------------------------------
const VERDICT_MAP = {
  approve: { devStage: 'development', billyVerdict: 'approve' },
  vault: { devStage: 'vaulted', billyVerdict: 'vault' },
  reject: { devStage: 'killed', billyVerdict: 'reject' },
};

// ---------------------------------------------------------------------------
// Audio cache helpers
// ---------------------------------------------------------------------------
function audioCachePath(projectId, voiceId) {
  return path.join(AUDIO_CACHE_DIR, `${projectId}-${voiceId}.mp3`);
}

function legacyCachePath(projectId) {
  // Pre-voice-selection era: files named {projectId}.mp3
  return path.join(AUDIO_CACHE_DIR, `${projectId}.mp3`);
}

function findCachedAudio(projectId, voiceId) {
  const primary = audioCachePath(projectId, voiceId);
  if (fs.existsSync(primary)) return primary;
  // For the default voice, fall back to legacy cache file name
  if (voiceId === DEFAULT_VOICE_ID) {
    const legacy = legacyCachePath(projectId);
    if (fs.existsSync(legacy)) return legacy;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'lemon-pitch-server', pitches: pitchStore.length, status: 'ok' });
});

// GET /pitches — list active pitches (exclude already-decided), sorted by pendingSince desc
const DECIDED_STAGES = new Set(['development', 'killed', 'vaulted', 'passed', 'greenlit', 'packaging']);

function sortByPendingSince(arr) {
  return arr.slice().sort((a, b) => {
    const aDate = a.pendingSince || a.createdAt || '';
    const bDate = b.pendingSince || b.createdAt || '';
    return bDate.localeCompare(aDate);
  });
}

app.get('/pitches', (req, res) => {
  const list = sortByPendingSince(pitchStore.filter((p) => !DECIDED_STAGES.has(p.devStage)))
    .map((p) => ({
      pitchNumber: p.pitchNumber,
      title: p.title,
      format: p.format,
      genre: p.genre || '',
      projectId: p.projectId,
      hasSpeech: !!findCachedAudio(p.projectId, DEFAULT_VOICE_ID),
      verdictStatus: p.billyVerdict || null,
      devStage: p.devStage || null,
    }));
  res.json(list);
});

// GET /pitches/roster — active pitches only (mirrors Dev Gate: excludes decided stages)
// Add ?all=true to include historical decided pitches.
// Must be registered before /pitches/:projectId to avoid param capture.
app.get('/pitches/roster', (req, res) => {
  const includeAll = req.query.all === 'true';
  const list = sortByPendingSince(includeAll ? pitchStore : pitchStore.filter((p) => !DECIDED_STAGES.has(p.devStage)));
  res.json(list.map(p => ({
    pitchNumber: p.pitchNumber,
    title: p.title,
    format: p.format,
    genre: p.genre || '',
    logline: p.logline || '',
    projectId: p.projectId,
    hasSpeech: !!findCachedAudio(p.projectId, DEFAULT_VOICE_ID),
    verdictStatus: p.billyVerdict || null,
    devStage: p.devStage || null,
    receivedAt: p.pendingSince || p.createdAt || null,
  })))
})

// GET /pitches/:projectId — full pitch detail
app.get('/pitches/:projectId', (req, res) => {
  const pitch = pitchStore.find((p) => p.projectId === req.params.projectId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

  res.json({
    pitchNumber: pitch.pitchNumber,
    title: pitch.title,
    format: pitch.format,
    platform: pitch.platform,
    genre: pitch.genre,
    cleanScript: pitch.cleanScript,
    logline: pitch.logline,
    comps: pitch.comps || '',
    projectId: pitch.projectId,
    devStage: pitch.devStage,
    billyVerdict: pitch.billyVerdict,
    hasSpeech: !!findCachedAudio(pitch.projectId, DEFAULT_VOICE_ID),
  });
});

// GET /pitches/:projectId/audio?voice=voiceId — stream TTS audio
// Supports HTTP Range requests (required for Safari/iOS audio playback).
app.get('/pitches/:projectId/audio', async (req, res) => {
  const pitch = pitchStore.find((p) => p.projectId === req.params.projectId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

  const voiceId = (req.query.voice && typeof req.query.voice === 'string')
    ? req.query.voice
    : DEFAULT_VOICE_ID;

  // Check cache
  const cached = findCachedAudio(pitch.projectId, voiceId);
  if (cached) {
    // res.sendFile handles Range requests automatically (required for Safari/iOS)
    return res.sendFile(path.resolve(cached));
  }

  // Generate via ElevenLabs
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured' });
  }

  if (!pitch.cleanScript) {
    return res.status(422).json({ error: 'No script available for this pitch' });
  }

  try {
    console.log(`Generating audio for pitch ${pitch.pitchNumber}: "${pitch.title}" voice=${voiceId}`);
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: pitch.cleanScript,
          model_id: ELEVENLABS_MODEL,
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error('ElevenLabs error:', elevenRes.status, errText);
      return res.status(502).json({ error: 'TTS generation failed', detail: errText });
    }

    // Buffer all chunks — avoids the double-pipe race condition and ensures
    // complete data before writing cache and setting Content-Length for Range support.
    const chunks = [];
    elevenRes.body.on('data', (chunk) => chunks.push(chunk));
    elevenRes.body.on('error', (err) => {
      console.error('ElevenLabs stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Stream error from ElevenLabs' });
    });
    elevenRes.body.on('end', () => {
      const buffer = Buffer.concat(chunks);

      // Write to cache (fire-and-forget, don't block the response)
      const cacheFile = audioCachePath(pitch.projectId, voiceId);
      fs.writeFile(cacheFile, buffer, (err) => {
        if (err) console.error('Audio cache write error:', err);
        else console.log(`Cached: ${path.basename(cacheFile)}`);
      });

      // Serve to client with full Range support headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Accept-Ranges', 'bytes');
      res.end(buffer);
    });
  } catch (err) {
    console.error('Audio generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /voices — list available ElevenLabs voices
app.get('/voices', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.json([
      { id: DEFAULT_VOICE_ID, name: 'Charlie', description: 'Deep, confident, energetic' },
    ]);
  }

  try {
    const voiceRes = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (!voiceRes.ok) throw new Error(`HTTP ${voiceRes.status}`);
    const data = await voiceRes.json();
    const voices = data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: v.labels
        ? Object.values(v.labels).filter(Boolean).join(', ')
        : '',
      preview_url: v.preview_url || null,
    }));
    // Sort so the default voice appears first
    voices.sort((a, b) => {
      if (a.id === DEFAULT_VOICE_ID) return -1;
      if (b.id === DEFAULT_VOICE_ID) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json(voices);
  } catch (err) {
    console.error('Failed to fetch ElevenLabs voices:', err.message);
    res.json([{ id: DEFAULT_VOICE_ID, name: 'Charlie', description: 'Deep, confident, energetic' }]);
  }
});

// GET /stats — aggregate pitch verdict stats
app.get('/stats', (req, res) => {
  const total = pitchStore.length;
  const approved = pitchStore.filter((p) => p.billyVerdict === 'approve').length;
  const vaulted = pitchStore.filter((p) => p.billyVerdict === 'vault').length;
  const rejected = pitchStore.filter((p) => p.billyVerdict === 'reject').length;
  const pending = total - approved - vaulted - rejected;

  res.json({
    total,
    approved,
    vaulted,
    rejected,
    pending,
    decided: approved + vaulted + rejected,
  });
});

// GET /admin — browser-accessible admin panel with one-click Refresh button
function renderAdmin(syncResult) {
  const intake = sortByPendingSince(pitchStore.filter(p => !DECIDED_STAGES.has(p.devStage)));
  const top5 = intake.slice(0, 5);
  const syncMsg = syncResult
    ? (syncResult.ok ? `Synced ${syncResult.updated} pitches from Dev Gate.` : `Sync failed: ${syncResult.error}`)
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lemon Pitch Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; padding: 40px 24px; max-width: 560px; margin: 0 auto; }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 4px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 32px; }
    .stat-block { margin-bottom: 28px; }
    .stat { font-size: 56px; font-weight: 800; color: #f5e642; line-height: 1; }
    .stat-label { font-size: 13px; color: #666; margin-top: 4px; }
    .top5 { margin: 24px 0; }
    .top5 h2 { font-size: 11px; font-weight: 600; letter-spacing: 1px; color: #444; text-transform: uppercase; margin-bottom: 10px; }
    .top5 ol { padding-left: 20px; }
    .top5 li { font-size: 14px; padding: 5px 0; color: #bbb; border-bottom: 1px solid #1a1a1a; }
    .top5 li:first-child { color: #fff; font-weight: 600; }
    .btn { display: inline-block; background: #f5e642; color: #000; border: none; padding: 14px 28px; font-size: 15px; font-weight: 700; border-radius: 10px; cursor: pointer; margin-top: 8px; width: 100%; text-align: center; }
    .btn:hover { background: #ffe44d; }
    .btn-primary { display: inline-block; background: #fff; color: #000; text-decoration: none; padding: 16px 28px; font-size: 16px; font-weight: 800; border-radius: 10px; margin-top: 24px; width: 100%; text-align: center; letter-spacing: -0.3px; }
    .btn-primary:hover { background: #eee; }
    .msg { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 13px; background: #111; color: #4ade80; }
    .msg.err { color: #f87171; }
    .links { margin-top: 24px; font-size: 12px; color: #444; }
    .links a { color: #666; text-decoration: none; margin-right: 12px; }
    .links a:hover { color: #aaa; }
  </style>
</head>
<body>
  <h1>Lemon Pitch Admin</h1>
  <p class="sub">pitches-api.billyrovzar.com</p>
  <div class="stat-block">
    <div class="stat">${intake.length}</div>
    <div class="stat-label">intake pitches in queue</div>
  </div>
  <div class="top5">
    <h2>Top 5 by received</h2>
    <ol>${top5.map(p => `<li>${p.title}</li>`).join('')}</ol>
  </div>
  <a class="btn-primary" href="https://pitch.billyrovzar.com" target="_blank">Open Pitch Terminal &rarr;</a>
  <form method="POST" action="/refresh?redirect=1" style="margin-top:16px;">
    <button class="btn" type="submit">Refresh from Dev Gate</button>
  </form>
  ${syncMsg ? `<div class="msg${syncResult && !syncResult.ok ? ' err' : ''}">${syncMsg}</div>` : ''}
  <div class="links">
    <a href="/pitches/roster">View roster JSON</a>
    <a href="/stats">Stats JSON</a>
    <a href="/admin">Reload page</a>
  </div>
</body>
</html>`;
}

app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(renderAdmin(null));
});

// POST /refresh — on-demand Paperclip Dev Gate sync, returns full roster as summaries
// If ?redirect=1 (browser form), redirects to /admin after sync.
app.post('/refresh', async (req, res) => {
  const syncResult = await refreshLiveDevStages()
  if (req.query.redirect === '1') {
    return res.redirect('/admin?synced=1');
  }
  res.json({
    synced: new Date().toISOString(),
    syncResult,
    pitches: pitchStore.map(p => ({
      pitchNumber: p.pitchNumber,
      title: p.title,
      format: p.format,
      genre: p.genre || '',
      logline: p.logline || '',
      projectId: p.projectId,
      hasSpeech: !!findCachedAudio(p.projectId, DEFAULT_VOICE_ID),
      verdictStatus: p.billyVerdict || null,
      devStage: p.devStage || null,
      receivedAt: p.pendingSince || p.createdAt || null,
    })),
  })
})

// POST /pitches/:projectId/verdict — record verdict locally, sync to Paperclip in background
// IMPORTANT: This handler is intentionally synchronous. The Paperclip cloud sync is
// fire-and-forget so that Railway's inability to reach api.paperclip.ing never blocks the
// verdict response. Local in-memory state + pitchMapping.json are the sources of truth.
app.post('/pitches/:projectId/verdict', (req, res) => {
  try {
    const body = req.body || {};
    const { verdict } = body;
    const { projectId } = req.params;

    if (!verdict || !VERDICT_MAP[verdict]) {
      return res.status(400).json({ error: 'verdict must be "approve", "vault", or "reject"' });
    }

    const pitch = pitchStore.find((p) => p.projectId === projectId);
    if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

    const payload = VERDICT_MAP[verdict];

    // Update in-memory state first — this is the source of truth for filtering
    pitch.billyVerdict = payload.billyVerdict;
    pitch.devStage = payload.devStage;

    // Persist to pitchMapping.json (best-effort — Railway filesystem may be ephemeral)
    try {
      const mappingPath = path.join(__dirname, 'pitchMapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      const entry = mapping.find((e) => e.projectId === projectId);
      if (entry) {
        entry.billyVerdict = payload.billyVerdict;
        entry.devStage = payload.devStage;
        fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
      }
    } catch (writeErr) {
      console.error('Failed to persist verdict to pitchMapping.json:', writeErr.message);
    }

    // Respond immediately — local state is already updated
    res.json({ projectId, verdict: payload.billyVerdict, devStage: payload.devStage, title: pitch.title });

    // Fire-and-forget Paperclip cloud sync (non-blocking, best-effort)
    if (PAPERCLIP_API_KEY) {
      const syncEndpoint = verdict === 'approve' ? 'approve' : verdict === 'vault' ? 'vault' : 'reject';
      const syncUrl = `${PAPERCLIP_API_URL}/api/projects/${projectId}/${syncEndpoint}`;
      // reject requires killReason; creative_pass is the appropriate default for pitch terminal decisions
      const syncBody = verdict === 'reject'
        ? JSON.stringify({ killReason: 'creative_pass' })
        : JSON.stringify({});
      fetch(syncUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}`, 'Content-Type': 'application/json' },
        body: syncBody,
      })
        .then((r) => {
          if (!r.ok) return r.text().then((t) => { throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`) });
          return r.json();
        })
        .then(() => console.log(`Paperclip synced: ${pitch.title} → ${verdict}`))
        .catch((err) => console.warn(`Paperclip sync skipped (verdict saved locally): ${err.message}`));
    }
  } catch (err) {
    console.error('Unexpected verdict handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Verdict handler error', detail: err.message });
  }
});

// DELETE /pitches/:projectId/verdict — undo verdict (reset to intake/null)
app.delete('/pitches/:projectId/verdict', (req, res) => {
  try {
    const pitch = pitchStore.find((p) => p.projectId === req.params.projectId);
    if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

    pitch.billyVerdict = null;
    pitch.devStage = 'intake';

    try {
      const mappingPath = require('path').join(__dirname, 'pitchMapping.json');
      const mapping = JSON.parse(require('fs').readFileSync(mappingPath, 'utf8'));
      const entry = mapping.find((e) => e.projectId === req.params.projectId);
      if (entry) {
        entry.billyVerdict = null;
        entry.devStage = 'intake';
        require('fs').writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
      }
    } catch (writeErr) {
      console.error('Failed to persist undo to pitchMapping.json:', writeErr.message);
    }

    res.json({ projectId: req.params.projectId, reset: true });
  } catch (err) {
    console.error('Unexpected undo verdict error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Undo handler error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Live devStage refresh via single bulk query (more reliable than 61 individual fetches)
// ---------------------------------------------------------------------------
async function refreshLiveDevStages() {
  if (!PAPERCLIP_API_KEY) {
    console.warn('Bulk devStage refresh skipped: PAPERCLIP_API_KEY not set.');
    return { ok: false, error: 'PAPERCLIP_API_KEY not set', updated: 0 };
  }

  try {
    const r = await fetch(
      `${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/projects?board=development_gate`,
      { headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` } }
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const allProjects = await r.json();

    // Build lookup map projectId → live state
    const liveMap = {};
    for (const proj of allProjects) {
      liveMap[proj.id] = {
        devStage: proj.devStage,
        billyVerdict: proj.billyVerdict,
        createdAt: proj.createdAt ?? null,
        pendingSince: proj.pendingSince ?? null,
        // Enrich pitches that have no script data with Paperclip project fields
        pitchSynopsis: proj.pitchSynopsis ?? null,
        comps: proj.comps ?? null,
        format: proj.format ?? null,
      };
    }

    let updated = 0;
    for (const pitch of pitchStore) {
      const live = liveMap[pitch.projectId];
      if (live) {
        if (live.devStage) pitch.devStage = live.devStage;
        if (live.billyVerdict) pitch.billyVerdict = live.billyVerdict;
        if (live.createdAt) pitch.createdAt = live.createdAt;
        if (live.pendingSince) pitch.pendingSince = live.pendingSince;
        // Fill in logline and comps from Paperclip project if the pitch has no script data
        if (!pitch.logline && live.pitchSynopsis) pitch.logline = live.pitchSynopsis;
        if (!pitch.comps && live.comps) pitch.comps = live.comps;
        if (!pitch.format && live.format) pitch.format = live.format;
        updated++;
      }
    }

    // Auto-discover new pitches from Paperclip Dev Gate not yet in pitchStore.
    // A real pitch always has `format` set; operational projects (Routines, HR, etc.) have format=null.
    const existingIds = new Set(pitchStore.map((p) => p.projectId));
    const newPitches = [];
    for (const proj of allProjects) {
      if (!existingIds.has(proj.id) && proj.format && !DECIDED_STAGES.has(proj.devStage)) {
        newPitches.push(proj);
      }
    }
    if (newPitches.length > 0) {
      // Sort ascending by pendingSince||createdAt so the newest pitch ends up with the highest
      // pitchNumber — the Pitch Intelligence Terminal sorts by pitchNumber descending, so highest = first.
      newPitches.sort((a, b) => {
        const aDate = a.pendingSince || a.createdAt || '';
        const bDate = b.pendingSince || b.createdAt || '';
        return aDate.localeCompare(bDate);
      });
      const maxNum = Math.max(...pitchStore.map((p) => p.pitchNumber), 0);
      let nextNum = maxNum + 1;
      for (const proj of newPitches) {
        pitchStore.push({
          pitchNumber: nextNum++,
          title: proj.name,
          projectId: proj.id,
          format: proj.format || '',
          genre: '',
          logline: proj.pitchSynopsis || '',
          comps: proj.comps || '',
          cleanScript: '',
          devStage: proj.devStage || 'intake',
          billyVerdict: proj.billyVerdict || null,
          pendingSince: proj.pendingSince || null,
          createdAt: proj.createdAt || null,
        });
      }
      console.log(`Auto-discovered ${newPitches.length} new pitches from Paperclip (pitchNumbers ${maxNum + 1}–${nextNum - 1}).`);
    }

    const decided = pitchStore.filter((p) => DECIDED_STAGES.has(p.devStage)).length;
    const pending = pitchStore.length - decided;
    console.log(`Bulk devStage refresh: ${updated}/${pitchStore.length} pitches updated — ${pending} pending, ${decided} decided.`);
    return { ok: true, updated, decided, pending, total: pitchStore.length, discovered: newPitches.length };
  } catch (err) {
    console.error(`Bulk devStage refresh failed: ${err.message}. Retaining cached devStages.`);
    return { ok: false, error: err.message, updated: 0 };
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadPitches().then(async () => {
  await refreshLiveDevStages();
  // Sync devStages from Paperclip every 5 minutes to pick up external changes
  setInterval(refreshLiveDevStages, 5 * 60 * 1000);
  app.listen(PORT, () => {
    console.log(`Lemon Pitch Server running on port ${PORT}`);
    console.log(`Default voice: Charlie (${DEFAULT_VOICE_ID})`);
  });
});
