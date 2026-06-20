require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[WARNING] SUPABASE_URL or SUPABASE_KEY not set. Set them in your environment.');
}

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const TABLE = 'links';
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 7);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Injects a small config object into the page before the main <script> runs,
// so the same index.html can render either the setup page or the unlock page.
function sendPageWithConfig(res, config) {
  const injected = `<script>window.__GATEKEEPER__ = ${JSON.stringify(config)};</script>\n`;
  const html = INDEX_HTML.replace('<script>\n/* ====', injected + '<script>\n/* ====');
  res.send(html);
}

// Home page (setup form)
app.get('/', (req, res) => {
  sendPageWithConfig(res, { mode: 'setup' });
});

// Create a new link
app.post('/api/links', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.' });
  }

  const { action_type, youtube_link, destination_link, wait_seconds } = req.body;

  if (!['subscribe', 'like'].includes(action_type)) {
    return res.status(400).json({ error: 'Invalid action_type.' });
  }
  if (!isValidUrl(youtube_link)) {
    return res.status(400).json({ error: 'Invalid YouTube link.' });
  }
  if (!isValidUrl(destination_link)) {
    return res.status(400).json({ error: 'Invalid destination link.' });
  }

  const code = nanoid();
  const wait = Number.isInteger(Number(wait_seconds)) && Number(wait_seconds) > 0
    ? Number(wait_seconds)
    : 15;

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      code,
      action_type,
      youtube_link,
      destination_link,
      wait_seconds: wait,
      clicks: 0,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create link. Check Supabase table setup.' });
  }

  const fullUrl = `${req.protocol}://${req.get('host')}/r/${code}`;
  res.json({ success: true, code, url: fullUrl, data });
});

// Unlock page — same index.html, different injected config
app.get('/r/:code', async (req, res) => {
  if (!supabase) {
    return res.status(500).send('Database not configured.');
  }

  const { code } = req.params;
  const { data, error } = await supabase
    .from(TABLE)
    .select('code, action_type, youtube_link, wait_seconds')
    .eq('code', code)
    .single();

  if (error || !data) {
    return sendPageWithConfig(res, { mode: 'notfound' });
  }

  sendPageWithConfig(res, { mode: 'unlock', data });
});

// Called after the countdown finishes, returns the real destination
app.post('/api/links/:code/complete', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  const { code } = req.params;
  const { data, error } = await supabase
    .from(TABLE)
    .select('destination_link, clicks')
    .eq('code', code)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Link not found.' });
  }

  supabase
    .from(TABLE)
    .update({ clicks: (data.clicks || 0) + 1 })
    .eq('code', code)
    .then(() => {})
    .catch(() => {});

  res.json({ destination: data.destination_link });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
