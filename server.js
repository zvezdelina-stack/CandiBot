const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 3000;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY     = process.env.METAVIEW_API_KEY;

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Config ────────────────────────────────────────────────────────────────────
const REPORT_ID = '61729db2-3946-11f1-b952-fb44be0b5cdb';
const FIELD_IDS = [
  'default:candidate',
  'default:start_time',
  'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e',
  'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d',
  'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e',
  'AI:a9150424-49be-11f1-8e19-179706228ab0',
  'AI:b04c164c-49be-11f1-9b23-674021cd80ae',
  'AI:b76395ae-49be-11f1-b7cc-27718543b130',
  'AI:c3997064-49be-11f1-88cd-e34aef2bf193',
  'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46',
  'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042',
  'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285',
  'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9',
  'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915',
  'AI:ffcd1fa4-49be-11f1-a302-239193bb599f',
  'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb',
  'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2',
  'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de',
];

// ── HTTP helper (Chrome extension proxy only) ─────────────────────────────────
function postJsonRaw(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
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

// ── Core: streaming agentic loop with Claude+MCP ──────────────────────────────
async function fetchAndRankCandidates(jd) {
  const systemPrompt = `You are an expert executive recruiter at SwingSearch, a retained search firm for venture-backed tech startups.

Your job:
1. Use the search_conversations Metaview tool to fetch all candidates from report ID "${REPORT_ID}" with fields: ${JSON.stringify(FIELD_IDS)}. Use limit=50 and paginate with offset until has_more is false.
2. Rank every candidate by fit against the job description or scorecard the user provides.
3. Return ONLY a valid JSON object — no markdown, no commentary, no backticks.

Output format:
{
  "ranked": [
    {
      "name": "<candidate name>",
      "score": <0-100>,
      "tier": "Strong Fit" | "Possible Fit" | "Not a Fit",
      "headline": "<one sharp sentence on why they fit or don't>",
      "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
      "gaps": ["<gap 1>", "<gap 2>"],
      "functionLevel": "<Candidate Function & Level value or null>",
      "location": "<location or null>",
      "availability": "<availability or null>",
      "url": "<conversation url or null>"
    }
  ]
}

Scoring rubric:
- 80-100: Strong Fit
- 50-79: Possible Fit
- 0-49: Not a Fit

Be precise and opinionated. Do not hedge.`;

  const mcpServers = [
    {
      type: 'url',
      url: 'https://mcp.metaview.ai/mcp',
      name: 'metaview',
      authorization_token: METAVIEW_API_KEY,
    },
  ];

  const messages = [
    {
      role: 'user',
      content: `JOB DESCRIPTION / SCORECARD:\n\n${jd}\n\nFetch all candidates from the Metaview report and return the ranked JSON.`,
    },
  ];

  const MAX_ITERATIONS = 20;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`Agentic iteration ${iterations}`);

    // Use streaming to avoid timeout on long-running calls
    let fullText = '';
    let stopReason = null;
    let responseContent = [];

    const stream = await anthropic.beta.messages
      .stream(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 32000,
          system: systemPrompt,
          mcp_servers: mcpServers,
          messages,
        },
        { headers: { 'anthropic-beta': 'mcp-client-2025-04-04' } }
      );

    // Collect the full streamed response
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        fullText += event.delta.text;
      }
      if (event.type === 'message_stop') {
        stopReason = event.message?.stop_reason;
      }
    }

    // Get the final complete message
    const finalMessage = await stream.finalMessage();
    stopReason = finalMessage.stop_reason;
    responseContent = finalMessage.content;

    console.log(`stop_reason: ${stopReason}`);
    console.log(`content types: ${responseContent.map((b) => b.type).join(', ')}`);

    // Append assistant turn to messages
    messages.push({ role: 'assistant', content: responseContent });

    if (stopReason === 'end_turn') {
      const textBlocks = responseContent.filter((b) => b.type === 'text');
      const text = textBlocks[textBlocks.length - 1]?.text ?? '';
      console.log(`Final text preview: ${text.slice(0, 300)}`);
      const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON in response. Raw: ${text.slice(0, 400)}`);
      return JSON.parse(match[0]);
    }

    if (stopReason === 'tool_use') {
      // MCP tool results are handled by the SDK automatically on next iteration
      const mcpBlocks = responseContent.filter((b) => b.type === 'mcp_tool_use');
      const regularBlocks = responseContent.filter((b) => b.type === 'tool_use');
      console.log(`mcp_tool_use: ${mcpBlocks.length}, tool_use: ${regularBlocks.length}`);
      if (regularBlocks.length > 0) {
        throw new Error('Unexpected regular tool_use blocks — only MCP tools are supported.');
      }
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${stopReason}`);
  }

  throw new Error(`Loop exceeded ${MAX_ITERATIONS} iterations.`);
}

// ── Format results for Slack ──────────────────────────────────────────────────
function formatResultsForSlack(ranked, jdSnippet) {
  const top = ranked.slice(0, 10);
  const tierEmoji = { 'Strong Fit': '🟢', 'Possible Fit': '🟡', 'Not a Fit': '🔴' };

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🔍 Candidate Ranking Results', emoji: true } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Criteria:* ${jdSnippet}  •  *${ranked.length} candidates ranked*` }],
    },
    { type: 'divider' },
  ];

  top.forEach((r, i) => {
    const emoji = tierEmoji[r.tier] ?? '⚪';
    const nameLink = r.url ? `<${r.url}|${r.name}>` : r.name;
    const meta = [r.functionLevel, r.location, r.availability].filter(Boolean).join('  ·  ');
    const strengths = r.strengths?.slice(0, 2).map((s) => `+ ${s}`).join('\n') ?? '';
    const gaps = r.gaps?.slice(0, 1).map((g) => `– ${g}`).join('\n') ?? '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *#${i + 1} · ${nameLink}* — Score: *${r.score}*\n${r.headline}${meta ? `\n_${meta}_` : ''}${strengths ? `\n\`\`\`${strengths}${gaps ? '\n' + gaps : ''}\`\`\`` : ''}`,
      },
    });

    if (i < top.length - 1) blocks.push({ type: 'divider' });
  });

  if (ranked.length > 10) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_${ranked.length - 10} additional candidates not shown. Run the full ranker artifact in Claude for the complete list._`,
        },
      ],
    });
  }

  return blocks;
}

// ── Slack Bolt ────────────────────────────────────────────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const slackApp = new App({ token: SLACK_BOT_TOKEN, receiver });

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
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'jd_block',
          label: { type: 'plain_text', text: 'Job Description or Scorecard' },
          element: {
            type: 'plain_text_input',
            action_id: 'jd_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: 'Paste the job description, scorecard, or key criteria here…',
            },
          },
          hint: { type: 'plain_text', text: 'The more specific, the better the ranking.' },
        },
      ],
    },
  });
});

slackApp.view('rank_candidates_modal', async ({ ack, body, view, client }) => {
  await ack();

  const jd = view.state.values.jd_block.jd_input.value;
  const { channel_id } = JSON.parse(view.private_metadata ?? '{}');
  const userId = body.user.id;
  const target = channel_id || userId;

  setImmediate(async () => {
    let holdingTs;
    try {
      const holding = await client.chat.postMessage({
        channel: target,
        text: '⏳ Fetching candidates and running ranking… this usually takes 1–2 minutes.',
      });
      holdingTs = holding.ts;
    } catch (e) {
      console.error('Could not post holding message:', e.message);
    }

    try {
      const result = await fetchAndRankCandidates(jd);
      const ranked = result.ranked.sort((a, b) => b.score - a.score);
      const jdSnippet = jd.length > 120 ? jd.slice(0, 120) + '…' : jd;
      const blocks = formatResultsForSlack(ranked, jdSnippet);

      if (holdingTs) {
        await client.chat.update({ channel: target, ts: holdingTs, text: 'Ranking complete.', blocks });
      } else {
        await client.chat.postMessage({ channel: target, text: 'Ranking complete.', blocks });
      }
    } catch (err) {
      console.error('Ranking error:', err);
      const errMsg = `❌ Ranking failed: ${err.message ?? 'Unknown error'}`;
      if (holdingTs) {
        await client.chat.update({ channel: target, ts: holdingTs, text: errMsg });
      } else {
        await client.chat.postMessage({ channel: target, text: errMsg });
      }
    }
  });
});

// ── Express routes ────────────────────────────────────────────────────────────
const expressApp = receiver.app;
expressApp.use(express.json());

expressApp.post('/company-info', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = JSON.stringify(req.body);
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
      },
    },
    (apiRes) => {
      let buf = '';
      apiRes.on('data', (c) => (buf += c));
      apiRes.on('end', () =>
        res.status(apiRes.statusCode).set('Content-Type', 'application/json').send(buf)
      );
    }
  );
  apiReq.on('error', (e) => res.status(500).json({ error: e.message }));
  apiReq.write(data);
  apiReq.end();
});

expressApp.get('/dnp-list', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const data = fs.readFileSync(path.join(__dirname, 'dnp.csv'), 'utf8');
    res.set('Content-Type', 'text/plain').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not read DNP list' });
  }
});

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
