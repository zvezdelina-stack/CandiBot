const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT                = process.env.PORT || 3000;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY    = process.env.METAVIEW_API_KEY;

// ── Metaview config ───────────────────────────────────────────────────────────
const REPORT_ID = '61729db2-3946-11f1-b952-fb44be0b5cdb';
const FIELD_IDS = [
  'default:candidate',
  'default:start_time',
  'default:interviewer',
  'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e', // Candidate Function & Level
  'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d', // Leadership Scope
  'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e', // Go-to-Market Experience
  'AI:a9150424-49be-11f1-8e19-179706228ab0', // Company Stage Experience
  'AI:b04c164c-49be-11f1-9b23-674021cd80ae', // Primary Function
  'AI:b76395ae-49be-11f1-b7cc-27718543b130', // Cross-Functional Exposure
  'AI:c3997064-49be-11f1-88cd-e34aef2bf193', // Player/Coach Profile
  'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46', // Seniority Level
  'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042', // Comp Context
  'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285', // Availability & Timeline
  'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9', // Deal Size Experience
  'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915', // Technical Fluency & AI Comfort
  'AI:ffcd1fa4-49be-11f1-a302-239193bb599f', // Industry & Vertical Background
  'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb', // Reason for Looking
  'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2', // Compensation Expectations
  'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de', // Location
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getVal(conv, fieldId) {
  const entries = conv.fields?.[fieldId];
  if (!entries?.length) return null;
  const labels = entries.map(e => e.label ?? e.value).filter(Boolean);
  return labels.length ? labels.join(', ') : null;
}

function postJson(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchAllCandidates() {
  let all = [], offset = 0, hasMore = true;
  while (hasMore) {
    const result = await postJson(
      'api.metaview.ai',
      '/v1/conversations/search',
      { 'Authorization': `Bearer ${METAVIEW_API_KEY}` },
      { report_id: REPORT_ID, fields: FIELD_IDS, limit: 50, offset, sort_by: 'default:start_time', sort_ascending: false }
    );
    const convs = result.conversations ?? [];
    all = all.concat(convs);
    hasMore = result.has_more ?? false;
    offset += convs.length;
    if (!convs.length) break;
  }
  return all;
}

async function rankCandidates(jd, candidates) {
  const profiles = candidates.map((c, i) => ({
    index: i,
    name:             getVal(c, 'default:candidate') ?? `Candidate ${i + 1}`,
    date:             getVal(c, 'default:start_time'),
    url:              c.url,
    functionLevel:    getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
    leadershipScope:  getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
    gtm:              getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
    companyStage:     getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
    primaryFunction:  getVal(c, 'AI:b04c164c-49be-11f1-9b23-674021cd80ae'),
    crossFunctional:  getVal(c, 'AI:b76395ae-49be-11f1-b7cc-27718543b130'),
    playerCoach:      getVal(c, 'AI:c3997064-49be-11f1-88cd-e34aef2bf193'),
    seniority:        getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
    compContext:      getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
    availability:     getVal(c, 'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285'),
    dealSize:         getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
    techFluency:      getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
    industry:         getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
    reasonForLooking: getVal(c, 'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb'),
    compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
    location:         getVal(c, 'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de'),
  }));

  const result = await postJson(
    'api.anthropic.com',
    '/v1/messages',
    { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are an expert executive recruiter at SwingSearch, a retained search firm for venture-backed tech startups.
Rank every candidate by fit against the job description or scorecard provided.
Return ONLY valid JSON — no markdown, no commentary, no backticks.

Output format:
{
  "ranked": [
    {
      "index": <original index>,
      "name": "<candidate name>",
      "score": <0-100>,
      "tier": "Strong Fit" | "Possible Fit" | "Not a Fit",
      "headline": "<one sharp sentence on why they fit or don't>",
      "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
      "gaps": ["<gap 1>", "<gap 2>"],
      "functionLevel": "<value or null>",
      "location": "<value or null>",
      "availability": "<value or null>",
      "url": "<value or null>"
    }
  ]
}

Scoring rubric:
- 80-100: Strong Fit — meets or exceeds most criteria, minimal gaps
- 50-79: Possible Fit — meaningful overlap but notable gaps or mismatches
- 0-49: Not a Fit — fundamental mismatch on function, level, or key requirements

Be precise and opinionated. Do not hedge. Flag missing data as a gap only if relevant to the JD criteria.`,
      messages: [{
        role: 'user',
        content: `JOB DESCRIPTION / SCORECARD:\n${jd}\n\nCANDIDATE PROFILES:\n${JSON.stringify(profiles, null, 2)}`
      }]
    }
  );

  const text = result.content?.find(b => b.type === 'text')?.text ?? '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

function formatResultsForSlack(ranked, jdSnippet) {
  const top = ranked.slice(0, 10); // Slack message limits — show top 10
  const tierEmoji = { 'Strong Fit': '🟢', 'Possible Fit': '🟡', 'Not a Fit': '🔴' };

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔍 Candidate Ranking Results', emoji: true }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Criteria:* ${jdSnippet}  •  *${ranked.length} candidates ranked*` }]
    },
    { type: 'divider' },
  ];

  top.forEach((r, i) => {
    const emoji = tierEmoji[r.tier] ?? '⚪';
    const nameLink = r.url ? `<${r.url}|${r.name}>` : r.name;
    const meta = [r.functionLevel, r.location, r.availability].filter(Boolean).join('  ·  ');
    const strengths = r.strengths?.slice(0, 2).map(s => `+ ${s}`).join('\n') ?? '';
    const gaps = r.gaps?.slice(0, 1).map(g => `– ${g}`).join('\n') ?? '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *#${i + 1} · ${nameLink}* — Score: *${r.score}*\n${r.headline}${meta ? `\n_${meta}_` : ''}${strengths ? `\n\`\`\`${strengths}${gaps ? '\n' + gaps : ''}\`\`\`` : ''}`
      }
    });

    if (i < top.length - 1) blocks.push({ type: 'divider' });
  });

  if (ranked.length > 10) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${ranked.length - 10} additional candidates not shown. Run the full ranker artifact in Claude for the complete list._` }]
    });
  }

  return blocks;
}

// ── Slack Bolt app ────────────────────────────────────────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Slash command — open modal
slackApp.command('/rank-candidates', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'rank_candidates_modal',
      private_metadata: JSON.stringify({ channel_id: body.channel_id }),
      title: { type: 'plain_text', text: 'Rank Candidates' },
      submit: { type: 'plain_text', text: 'Run Ranking' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'jd_block',
          label: { type: 'plain_text', text: 'Job Description or Scorecard' },
          element: {
            type: 'plain_text_input',
            action_id: 'jd_input',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Paste the job description, scorecard, or key criteria here…' },
          },
          hint: { type: 'plain_text', text: 'The more specific, the better the ranking.' }
        }
      ]
    }
  });
});

// Modal submission — run ranking
slackApp.view('rank_candidates_modal', async ({ ack, body, view, client }) => {
  await ack();

  const jd = view.state.values.jd_block.jd_input.value;
  const { channel_id } = JSON.parse(view.private_metadata ?? '{}');
  const userId = body.user.id;

  // Post an immediate holding message
  let holdingTs;
  try {
    const holding = await client.chat.postMessage({
      channel: channel_id || userId,
      text: '⏳ Fetching candidates and running ranking… this usually takes 20–40 seconds.',
    });
    holdingTs = holding.ts;
  } catch {
    // If channel post fails, fall back to DM
    await client.chat.postMessage({
      channel: userId,
      text: '⏳ Fetching candidates and running ranking… this usually takes 20–40 seconds.',
    });
  }

  try {
    const candidates = await fetchAllCandidates();
    if (!candidates.length) throw new Error('No candidates found in the Metaview report.');

    const result = await rankCandidates(jd, candidates);
    const ranked = result.ranked.sort((a, b) => b.score - a.score);
    const jdSnippet = jd.length > 120 ? jd.slice(0, 120) + '…' : jd;
    const blocks = formatResultsForSlack(ranked, jdSnippet);

    const target = channel_id || userId;

    // Replace holding message if possible, otherwise post new
    if (holdingTs && channel_id) {
      await client.chat.update({ channel: target, ts: holdingTs, text: 'Ranking complete.', blocks });
    } else {
      await client.chat.postMessage({ channel: target, text: 'Ranking complete.', blocks });
    }
  } catch (err) {
    console.error('Ranking error:', err);
    const target = channel_id || userId;
    const errMsg = `❌ Ranking failed: ${err.message ?? 'Unknown error'}. Check Railway logs for details.`;
    if (holdingTs && channel_id) {
      await client.chat.update({ channel: target, ts: holdingTs, text: errMsg });
    } else {
      await client.chat.postMessage({ channel: target, text: errMsg });
    }
  }
});

// ── Express app (shared with Bolt receiver) ───────────────────────────────────
const expressApp = receiver.app;

expressApp.use(express.json());

// Existing route: Chrome extension proxy to Anthropic
expressApp.post('/company-info', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const payload = req.body;
  const data = JSON.stringify(payload);
  const apiReq = https.request(
    {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }
    },
    apiRes => {
      let buf = '';
      apiRes.on('data', c => buf += c);
      apiRes.on('end', () => {
        res.status(apiRes.statusCode).set('Content-Type', 'application/json').send(buf);
      });
    }
  );
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(data);
  apiReq.end();
});

// Existing route: DNP list
expressApp.get('/dnp-list', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const data = fs.readFileSync(path.join(__dirname, 'dnp.csv'), 'utf8');
    res.set('Content-Type', 'text/plain').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not read DNP list' });
  }
});

// CORS preflight for Chrome extension
expressApp.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await slackApp.start(PORT);
  console.log(`Server running on port ${PORT}`);
})();
