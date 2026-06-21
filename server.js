'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { parsePitchDocument } = require('./pitchParser');

// Pre-bundled pitch scripts (full text, pre-parsed at build time)
const BUNDLED_SCRIPTS = require('./pitchScripts.json');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || 'https://api.paperclip.ing';
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || 'ff52ad91-250b-4d9d-a2ee-1d24b65ec3e8';
const PITCH_DOC_ISSUE_ID = '6159de20-0610-4c00-95fd-fd842e3af93e';

// ElevenLabs voice: Charlie — Deep, Confident, Energetic (hyped)
// Perfect for an enthusiastic Hollywood pitch executive delivering pitches.
const ELEVENLABS_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';
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
      devStage: entry.devStage,
      billyVerdict: entry.billyVerdict,
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
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'lemon-pitch-server', pitches: pitchStore.length, status: 'ok' });
});

// GET /pitches — list active pitches (exclude already-decided: killed, vaulted, passed, greenlit)
const DECIDED_STAGES = new Set(['killed', 'vaulted', 'passed', 'greenlit']);
app.get('/pitches', (req, res) => {
  const list = pitchStore
    .filter((p) => !DECIDED_STAGES.has(p.devStage))
    .map((p) => ({
      pitchNumber: p.pitchNumber,
      title: p.title,
      format: p.format,
      projectId: p.projectId,
      hasSpeech: fs.existsSync(path.join(AUDIO_CACHE_DIR, `${p.projectId}.mp3`)),
      verdictStatus: p.billyVerdict || null,
      devStage: p.devStage || null,
    }));
  res.json(list);
});

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
    projectId: pitch.projectId,
    devStage: pitch.devStage,
    billyVerdict: pitch.billyVerdict,
    hasSpeech: fs.existsSync(path.join(AUDIO_CACHE_DIR, `${pitch.projectId}.mp3`)),
  });
});

// GET /pitches/:projectId/audio — stream TTS audio, generate + cache on first request
app.get('/pitches/:projectId/audio', async (req, res) => {
  const pitch = pitchStore.find((p) => p.projectId === req.params.projectId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

  const audioPath = path.join(AUDIO_CACHE_DIR, `${pitch.projectId}.mp3`);

  // Serve from cache if available
  if (fs.existsSync(audioPath)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(audioPath).pipe(res);
  }

  // Generate via ElevenLabs
  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'ElevenLabs API key not configured' });
  }

  if (!pitch.cleanScript) {
    return res.status(422).json({ error: 'No script available for this pitch' });
  }

  try {
    console.log(`Generating audio for pitch ${pitch.pitchNumber}: ${pitch.title}`);
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
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

    // Write to cache and stream to client
    const writeStream = fs.createWriteStream(audioPath);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    elevenRes.body.pipe(writeStream);
    elevenRes.body.pipe(res);

    writeStream.on('error', (err) => console.error('Cache write error:', err));
    elevenRes.body.on('error', (err) => console.error('ElevenLabs stream error:', err));
  } catch (err) {
    console.error('Audio generation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /pitches/:projectId/verdict — submit verdict to Paperclip
app.post('/pitches/:projectId/verdict', async (req, res) => {
  const { verdict } = req.body;
  const { projectId } = req.params;

  if (!verdict || !VERDICT_MAP[verdict]) {
    return res.status(400).json({ error: 'verdict must be "approve", "vault", or "reject"' });
  }

  const pitch = pitchStore.find((p) => p.projectId === projectId);
  if (!pitch) return res.status(404).json({ error: 'Pitch not found' });

  if (!PAPERCLIP_API_KEY) {
    return res.status(503).json({ error: 'Paperclip API key not configured' });
  }

  const payload = VERDICT_MAP[verdict];

  try {
    const ppRes = await fetch(`${PAPERCLIP_API_URL}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!ppRes.ok) {
      const errText = await ppRes.text();
      console.error('Paperclip verdict error:', ppRes.status, errText);
      return res.status(502).json({ error: 'Paperclip API error', detail: errText });
    }

    const updated = await ppRes.json();

    // Update in-memory state
    pitch.billyVerdict = payload.billyVerdict;
    pitch.devStage = payload.devStage;

    // Persist verdict to pitchMapping.json so it survives server restarts
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

    res.json({
      projectId,
      verdict: payload.billyVerdict,
      devStage: payload.devStage,
      title: pitch.title,
    });
  } catch (err) {
    console.error('Verdict submission error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Live devStage refresh from Paperclip
// Queries each pitch individually so we get the actual devStage/billyVerdict.
// The bulk ?devStage=development query returns board members regardless of actual
// devStage, so individual fetches are the reliable approach.
// ---------------------------------------------------------------------------
async function refreshLiveDevStages() {
  if (!PAPERCLIP_API_KEY) return;

  const BATCH = 10; // concurrent requests per batch
  let updated = 0;

  for (let i = 0; i < pitchStore.length; i += BATCH) {
    const batch = pitchStore.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (pitch) => {
        try {
          const r = await fetch(`${PAPERCLIP_API_URL}/api/projects/${pitch.projectId}`, {
            headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` },
          });
          if (!r.ok) return;
          const proj = await r.json();
          if (proj.devStage) pitch.devStage = proj.devStage;
          if (proj.billyVerdict) pitch.billyVerdict = proj.billyVerdict;
          updated++;
        } catch { /* keep existing value */ }
      })
    );
  }

  const decided = pitchStore.filter((p) => DECIDED_STAGES.has(p.devStage)).length;
  console.log(`Live devStage refresh: ${updated} fetched, ${decided} decided (excluded from queue).`);
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
    console.log(`Voice: Charlie (IKne3meq5aSn9XLyUdCD) — Deep, Confident, Energetic`);
  });
});
