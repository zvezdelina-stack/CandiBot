import pkg from '@slack/bolt';
const { App } = pkg;
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import express from 'express';
import https from 'https';

// ── Env ───────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY        = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN          = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN          = process.env.SLACK_APP_TOKEN;
const SLACK_SIGNING_SECRET     = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY         = process.env.METAVIEW_API_KEY;
const RANKING_PASSWORD         = process.env.RANKING_PASSWORD;
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUBLIC_URL               = process.env.PUBLIC_URL || 'https://candibot-production.up.railway.app';
const PORT                     = process.env.PORT || 8080;

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// ── Retry wrapper ─────────────────────────────────────────────────────────────
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.status === 429;
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '10', 10);
      if (isRateLimit && attempt < maxAttempts) {
        const wait = (retryAfter + 2) * 1000;
        console.log(`Rate limited. Waiting ${retryAfter + 2}s before retry ${attempt + 1}/${maxAttempts}...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ── Safe JSON parse — strips control characters that break JSON.parse ───────────
function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  try {
    // Strip unescaped control chars; preserve \n \r \t as proper escapes
    const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, function(c) {
      if (c === '\n') return '\\n';
      if (c === '\r') return '\\r';
      if (c === '\t') return '\\t';
      return '';
    });
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

// ── Config ────────────────────────────────────────────────────────────────────
// ── Metaview report IDs per function ─────────────────────────────────────────
// Create one saved report per function in Metaview (filtered by Primary Function),
// then paste each report's UUID from the URL: app.metaview.ai/reports/<uuid>
const REPORT_IDS = {
  'Sales':              '112a923e-5308-11f1-92cb-73244d6b0d33',
  'Marketing':          '16fba9c4-5302-11f1-a6d5-537df3062a22',
  'Product':            'f1a6ec00-5307-11f1-9190-778a4330fa61',
  'Engineering':        '0b1ffe08-5301-11f1-ba5a-8702f0ef4c78',
  'Design':             'e8c223d6-5300-11f1-b327-970da0c4f185',
  'People / HR':        '86735e8c-5307-11f1-851f-23286cd35cc4',
  'Finance':            '5ca0c028-5301-11f1-99c8-dfea1ef56f68',
  'Operations':         '2ffdbe58-5307-11f1-a502-c7feb36b30f2',
  'Customer Success':   '0c9ef8ca-5085-11f1-8bac-ab512eacbb70',
  'Legal':              'f6e342b4-5301-11f1-9d38-97ef855eada6',
  'Data / Analytics':   '493c1c72-5300-11f1-98ed-ab1c6a3a00a6',
  'General Management': '7fc1b4d6-5301-11f1-b0dc-37ad7c65ac80',
};

// Fallback to the full Candidate Interviews report if function not matched
const REPORT_ID_FALLBACK = '61729db2-3946-11f1-b952-fb44be0b5cdb';
const RANKING_TTL = 30 * 24 * 60 * 60; // 30 days
const SESSION_TTL = 60 * 60;            // 1 hour
const JOB_TTL     = 24 * 60 * 60;       // 1 day (in-progress jobs)
const MCP_SERVERS = [{ type: 'url', url: 'https://mcp.metaview.ai/mcp', name: 'metaview', authorization_token: METAVIEW_API_KEY }];

const PRIMARY_FUNCTIONS = [
  'Sales', 'Marketing', 'Product', 'Engineering', 'Design',
  'People / HR', 'Finance', 'Operations', 'Customer Success',
  'Legal', 'Data / Analytics', 'General Management',
];

const FIELD_IDS = [
  'default:candidate',
  'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e', // Function & Level
  'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46', // Seniority
  'AI:c3997064-49be-11f1-88cd-e34aef2bf193', // Player/Coach
  'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d', // Leadership Scope
  'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e', // GTM
  'AI:a9150424-49be-11f1-8e19-179706228ab0', // Company Stage
  'AI:ffcd1fa4-49be-11f1-a302-239193bb599f', // Industry
  'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9', // Deal Size
  'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915', // Tech Fluency
  'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de', // Location
  'AI:b04c164c-49be-11f1-9b23-674021cd80ae', // Primary Function
  'AI:b76395ae-49be-11f1-b7cc-27718543b130', // Cross-Functional
  'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042', // Comp Context
  'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285', // Availability
  'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb', // Reason for Looking
  'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2', // Comp Expectations
  'default:start_time',
  'default:interviewer',
];

// ── Session management ────────────────────────────────────────────────────────
async function getSession(userId) {
  try {
    const raw = await redis.get(`session:${userId}`);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return {}; }
}

async function setSession(userId, data) {
  try {
    const current = await getSession(userId);
    const updated = { ...current, ...data, updatedAt: Date.now() };
    await redis.set(`session:${userId}`, JSON.stringify(updated), { ex: SESSION_TTL });
  } catch (e) { console.error('Session write error:', e.message); }
}

async function clearSession(userId) {
  try { await redis.del(`session:${userId}`); } catch {}
}

// ── Ranking storage ───────────────────────────────────────────────────────────
async function saveRanking(id, data) {
  await redis.set(`ranking:${id}`, JSON.stringify(data), { ex: RANKING_TTL });
}

async function getRanking(id) {
  const raw = await redis.get(`ranking:${id}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Ranking job management ────────────────────────────────────────────────────
// Jobs are stored separately from final rankings.
// Status: pending | running | done | error
async function setJob(jobId, data) {
  await redis.set(`job:${jobId}`, JSON.stringify(data), { ex: JOB_TTL });
}

async function getJob(jobId) {
  const raw = await redis.get(`job:${jobId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Intent detection ──────────────────────────────────────────────────────────
const INTENTS = {
  RANK:      'rank',
  FIND:      'find',
  LOOKUP:    'lookup',
  FOLLOWUP:  'followup',
  SUMMARIZE: 'summarize',
  HELP:      'help',
  RESET:     'reset',
  DEEPER:    'deeper',
  UNKNOWN:   'unknown',
};

async function detectIntent(message, session) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: `You classify recruiter messages into intents. Return ONLY a JSON object with "intent" and "entities".

Intents:
- rank: user wants to rank/score candidates against a role or JD
- find: user wants to search for candidates matching criteria
- lookup: user wants info on a specific named candidate
- followup: user is asking a follow-up question about the last candidate discussed (e.g. "what was their comp?", "what about their GTM experience?") — use this when there's a candidate in session context and no new name is mentioned
- summarize: user wants a summary of conversations or a candidate
- help: user wants to know what the bot can do
- reset: user wants to clear context and start fresh
- deeper: user wants to search further back in the candidate database after a find query
- unknown: none of the above

Entities to extract:
- name: candidate name if mentioned
- role: job title or function if mentioned
- company: company name if mentioned (for rank intent)
- criteria: any search criteria mentioned
- jd: job description text if pasted (long text)

Current session context: ${JSON.stringify(session)}

Return format: {"intent": "rank", "entities": {"role": "VP Sales", "company": "Arlo", "jd": null}}`,
    messages: [{ role: 'user', content: message }]
  });

  const text = res.content.find(b => b.type === 'text')?.text ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { intent: INTENTS.UNKNOWN, entities: {} };
  try { return JSON.parse(match[0]); } catch { return { intent: INTENTS.UNKNOWN, entities: {} }; }
}

// ── Metaview helpers ──────────────────────────────────────────────────────────
function getVal(conv, fieldId) {
  const entries = conv.fields?.[fieldId];
  if (!entries?.length) return null;
  const labels = entries.map(e => e.label ?? e.value).filter(Boolean);
  return labels.length ? labels.join(', ') : null;
}

async function metaviewCall(toolName, params) {
  const final = await withRetry(async () => {
    const stream = anthropic.beta.messages.stream(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: `You are a Metaview API proxy. Call the ${toolName} tool with EXACTLY the parameters provided. Return nothing else.`,
        mcp_servers: MCP_SERVERS,
        messages: [{ role: 'user', content: `Call ${toolName} with these parameters: ${JSON.stringify(params)}` }]
      },
      { headers: { 'anthropic-beta': 'mcp-client-2025-04-04' } }
    );
    return stream.finalMessage();
  });

  const mcpResults = final.content.filter(b => b.type === 'mcp_tool_result');
  const textBlocks = final.content.filter(b => b.type === 'text');

  for (const block of mcpResults) {
    const raw = block.content?.[0]?.text ?? '';
    try { return JSON.parse(raw); } catch {}
  }
  for (const block of textBlocks) {
    const match = block.text?.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
  }
  return null;
}

async function fetchCandidates(filters, maxPages = 2, reportId = REPORT_ID_FALLBACK) {
  let all = [], offset = 0, hasMore = true, page = 0;

  while (hasMore && page < maxPages) {
    page++;
    console.log(`Fetching page ${page} (offset ${offset})...`);

    const result = await metaviewCall('search_conversations', {
      report_id: reportId,
      fields: FIELD_IDS,
      filters,
      limit: 50,
      offset,
      sort_by: 'default:start_time',
      sort_ascending: false
    });

    if (!result?.conversations?.length) {
      console.log(`Page ${page}: no results, stopping.`);
      break;
    }

    all = all.concat(result.conversations);
    hasMore = result.has_more ?? false;
    offset += result.conversations.length;
    console.log(`Page ${page}: +${result.conversations.length}, total: ${all.length}, has_more: ${hasMore}`);
  }

  return all;
}

// ── Ranking job runner (runs fully server-side, no browser needed) ─────────────
async function runRankingJob(jobId, jd, role, company, slackUserId, slackSay) {
  console.log(`[job:${jobId}] Starting ranking job — role: ${role}, company: ${company}`);

  try {
    // Update status to running
    await setJob(jobId, { status: 'running', role, company, startedAt: Date.now(), progress: 'Inferring primary function…' });

    // Stage 1: infer primary function
    const inferRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'You map job descriptions to exactly one primary function from a fixed list based on the PRIMARY role. Examples: VP of Sales → Sales. CMO → Marketing. Director of Product Marketing → Marketing. Head of Growth → Marketing. CTO → Engineering. Head of Product → Product. Return ONLY the exact function name from the list, nothing else — no explanation, no punctuation.',
      messages: [{ role: 'user', content: 'List:\n' + PRIMARY_FUNCTIONS.join('\n') + '\n\nWhat is the primary function of the role described below? If the role spans multiple functions (e.g. "Product Marketing"), return the one that best reflects the TEAM the person would sit on. Return only the function name.\n\n' + jd.slice(0, 2000) }]
    });
    const inferRaw = inferRes.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    const primaryFunction = PRIMARY_FUNCTIONS.find(f => inferRaw.toLowerCase().includes(f.toLowerCase())) ?? null;
    console.log(`[job:${jobId}] Inferred function: ${primaryFunction}`);

    // Stage 2: fetch candidates with function filter
    await setJob(jobId, { status: 'running', role, company, startedAt: Date.now(), progress: `Fetching ${primaryFunction ?? 'all'} candidates…` });

    // Pick the function-specific report — no filter needed, the report is the filter
    const reportId = (primaryFunction && REPORT_IDS[primaryFunction] && !REPORT_IDS[primaryFunction].startsWith('PASTE'))
      ? REPORT_IDS[primaryFunction]
      : REPORT_ID_FALLBACK;
    console.log(`[job:${jobId}] Using report: ${reportId} (${primaryFunction ?? 'fallback'})`);

    const filters = [
      { field_id: 'default:start_time', operation: 'after', value: { scope: 'relative', value: -63072000 } }
    ];

    const candidates = await fetchCandidates(filters, 2, reportId);
    console.log(`[job:${jobId}] Fetched ${candidates.length} candidates`);

    if (!candidates.length) {
      await setJob(jobId, { status: 'error', error: 'No candidates found for this function.' });
      if (slackSay) await slackSay(`❌ Ranking job *${role}${company ? ' at ' + company : ''}* found no candidates. Try a different JD or criteria.`);
      return;
    }

    // Stage 3: lightweight screen
    await setJob(jobId, { status: 'running', role, company, startedAt: Date.now(), progress: `Screening ${candidates.length} candidates…` });

    const slim = candidates.map((c, i) => ({
      i,
      name:          getVal(c, 'default:candidate') ?? `Candidate ${i + 1}`,
      functionLevel: getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority:     getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      companyStage:  getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      playerCoach:   getVal(c, 'AI:c3997064-49be-11f1-88cd-e34aef2bf193'),
      gtm:           getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
    }));

    const SCREEN_CHUNK = 200;
    const keepIndices = new Set();

    for (let ci = 0; ci < slim.length; ci += SCREEN_CHUNK) {
      if (ci > 0) await new Promise(r => setTimeout(r, 1000));
      const chunk = slim.slice(ci, ci + SCREEN_CHUNK);
      const screenRes = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'You are a recruiting screener. Return ONLY a JSON object {"keep":[...indices...]} of candidates worth deeper evaluation. Be inclusive — when in doubt, keep. Exclude only obvious mismatches (e.g. clearly junior IC when role needs VP). No other text.',
        messages: [{ role: 'user', content: `JD:\n${jd.slice(0, 1500)}\n\nCANDIDATES:\n${JSON.stringify(chunk)}` }]
      });
      const screenText = screenRes.content.find(b => b.type === 'text')?.text ?? '';
      const screenMatch = screenText.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (screenMatch) {
        try {
          const parsed = JSON.parse(screenMatch[0]);
          // localIdx is relative to this chunk; add ci to get absolute index
          (parsed.keep ?? []).forEach(localIdx => keepIndices.add(ci + localIdx));
        } catch (e) {
          console.error(`[job:${jobId}] Screen parse error at offset ${ci}:`, e.message);
        }
      }
    }

    // If screen returned nothing, skip screening and rank everything
    const screened = keepIndices.size > 0 ? candidates.filter((_, i) => keepIndices.has(i)) : candidates;
    console.log(`[job:${jobId}] Screen kept ${keepIndices.size} of ${candidates.length} (${keepIndices.size === 0 ? 'fallback: ranking all' : 'filtered'});`);
    console.log(`[job:${jobId}] Screened to ${screened.length} candidates`);

    // Stage 4: full ranking
    await setJob(jobId, { status: 'running', role, company, startedAt: Date.now(), progress: `Ranking ${screened.length} candidates…` });

    const profiles = screened.map((c, i) => ({
      index: i,
      name:             getVal(c, 'default:candidate') ?? `Candidate ${i + 1}`,
      url:              c.url,
      functionLevel:    getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority:        getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      playerCoach:      getVal(c, 'AI:c3997064-49be-11f1-88cd-e34aef2bf193'),
      leadershipScope:  getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
      gtm:              getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
      companyStage:     getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      crossFunctional:  getVal(c, 'AI:b76395ae-49be-11f1-b7cc-27718543b130'),
      compContext:      getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
      compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
      availability:     getVal(c, 'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285'),
      dealSize:         getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
      techFluency:      getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
      industry:         getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
      reasonForLooking: getVal(c, 'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb'),
      location:         getVal(c, 'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de'),
      date:             getVal(c, 'default:start_time'),
      interviewer:      getVal(c, 'default:interviewer'),
    }));

    const CHUNK = 80;
    const allRanked = [];

    for (let i = 0; i < profiles.length; i += CHUNK) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      const chunk = profiles.slice(i, i + CHUNK);
      const rankRes = await withRetry(() => anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `You are an expert executive recruiter at SwingSearch, a retained search firm for venture-backed tech startups.
Rank every candidate by fit against the job description. Return ONLY valid JSON — no markdown, no backticks.

Output:
{"ranked":[{"index":<original index>,"score":<0-100>,"tier":"Strong Fit"|"Possible Fit"|"Not a Fit","headline":"<one sharp sentence>","strengths":["<s1>","<s2>","<s3>"],"gaps":["<g1>","<g2>"],"note":"<one nuanced observation>"}]}

Scoring: 80-100 Strong Fit, 50-79 Possible Fit, 0-49 Not a Fit. Be opinionated. Include all candidates.`,
        messages: [{ role: 'user', content: `JD/SCORECARD:\n${jd}\n\nCANDIDATES:\n${JSON.stringify(chunk, null, 2)}` }]
      }));

      const rankText = rankRes.content.find(b => b.type === 'text')?.text ?? '';
      const rankMatch = rankText.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (rankMatch) {
        const parsed = safeParse(rankMatch[0]);
        if (parsed?.ranked?.length) {
          allRanked.push(...parsed.ranked);
        } else {
          console.error(`[job:${jobId}] Rank parse failed for batch at index ${i}, attempting per-candidate recovery`);
          // Attempt to recover individual candidate objects from the malformed JSON
          const objMatches = rankMatch[0].matchAll(/\{"index"\s*:\s*(\d+)[^}]*\}/g);
          for (const m of objMatches) {
            const obj = safeParse(m[0]);
            if (obj?.index !== undefined && obj?.score !== undefined) allRanked.push(obj);
          }
        }
      }
    }

    // Merge scores back with full profiles
    const ranked = allRanked.map(r => {
      const c = screened[r.index];
      return {
        ...r,
        name:             getVal(c, 'default:candidate') ?? `Candidate ${r.index + 1}`,
        url:              c.url,
        functionLevel:    getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
        seniority:        getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
        playerCoach:      getVal(c, 'AI:c3997064-49be-11f1-88cd-e34aef2bf193'),
        leadershipScope:  getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
        gtm:              getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
        companyStage:     getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
        crossFunctional:  getVal(c, 'AI:b76395ae-49be-11f1-b7cc-27718543b130'),
        compContext:      getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
        compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
        availability:     getVal(c, 'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285'),
        dealSize:         getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
        techFluency:      getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
        industry:         getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
        reasonForLooking: getVal(c, 'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb'),
        location:         getVal(c, 'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de'),
        date:             getVal(c, 'default:start_time'),
        interviewer:      getVal(c, 'default:interviewer'),
      };
    }).sort((a, b) => b.score - a.score);

    // Save final ranking
    const rankingId = crypto.randomBytes(8).toString('hex');
    const jdSnippet = jd.length > 100 ? jd.slice(0, 100) + '…' : jd;
    await saveRanking(rankingId, { jdSnippet, role, company, createdAt: new Date().toISOString(), ranked });

    const rankingUrl = `${PUBLIC_URL}/ranking/${rankingId}`;
    await setJob(jobId, { status: 'done', rankingUrl, rankingId });

    console.log(`[job:${jobId}] Done — ${ranked.length} candidates ranked. URL: ${rankingUrl}`);

    // Post results back to Slack
    if (slackSay) {
      const strong   = ranked.filter(r => r.tier === 'Strong Fit');
      const possible = ranked.filter(r => r.tier === 'Possible Fit');
      const notFit   = ranked.filter(r => r.tier === 'Not a Fit');

      const topStrong = strong.slice(0, 3).map((r, i) =>
        `${i + 1}. *${r.url ? `<${r.url}|${r.name}>` : r.name}* (${r.score}) — ${r.headline}`
      ).join('\n');

      await slackSay({
        text: `✅ Ranking complete for ${role}${company ? ' at ' + company : ''}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `📊 Ranking complete${company ? ': ' + company : ''}`, emoji: true }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${role}${company ? ' at ' + company : ''}*\n\n*${strong.length} Strong Fit  ·  ${possible.length} Possible Fit  ·  ${notFit.length} Not a Fit*\n_${ranked.length} candidates evaluated_`
            }
          },
          ...(strong.length > 0 ? [
            { type: 'divider' },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Top Strong Fit candidates:*\n${topStrong}` }
            }
          ] : []),
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `<${rankingUrl}|*View full ranking →*>  _(password protected, expires in 30 days)_` }
          }
        ]
      });
    }

  } catch (err) {
    console.error(`[job:${jobId}] Error:`, err.message);
    await setJob(jobId, { status: 'error', error: err.message });
    if (slackSay) {
      await slackSay(`❌ Ranking job failed: ${err.message}`);
    }
  }
}

// ── Intent handlers ───────────────────────────────────────────────────────────

// RANK: confirm job name, then kick off server-side ranking job
async function handleRank(say, userId, entities, session, rawMessage) {
  const role    = entities.role ?? session.activeRole;
  const company = entities.company ?? session.activeCompany;
  const jd      = entities.jd ?? (rawMessage?.length > 100 ? rawMessage : null);

  // Awaiting JD after confirmation
  if (session.awaitingRankJD && session.pendingRankRole) {
    const confirmedRole    = session.pendingRankRole;
    const confirmedCompany = session.pendingRankCompany;
    const confirmedJobName = session.pendingRankJobName;
    const incomingJD       = rawMessage?.length > 100 ? rawMessage : null;

    if (!incomingJD) {
      await say('Paste the job description or scorecard and I\'ll kick off the ranking.');
      return;
    }

    await setSession(userId, {
      awaitingRankJD: false, pendingRankRole: null,
      pendingRankCompany: null, pendingRankJobName: null
    });

    const jobId = crypto.randomBytes(6).toString('hex');
    await setJob(jobId, { status: 'pending', role: confirmedRole, company: confirmedCompany, jobName: confirmedJobName, createdAt: Date.now() });

    await say({
      text: `Starting ranking job for ${confirmedRole}${confirmedCompany ? ' at ' + confirmedCompany : ''}…`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔄 *Ranking started* — _${confirmedJobName}_\n\nFetching and scoring candidates now. This runs fully in the background — I'll post results here when it's done.\n\n_Typically takes 5–15 minutes depending on pipeline size._`
          }
        }
      ]
    });

    // Fire and forget — runs in background, posts results when done
    runRankingJob(jobId, incomingJD, confirmedRole, confirmedCompany, userId, say).catch(e => {
      console.error('Background ranking error:', e.message);
    });

    return;
  }

  // Awaiting confirmation of job name
  if (session.awaitingRankConfirm && session.pendingRankRole) {
    // User replied — treat their reply as confirmation or correction
    const isConfirmed = /^(yes|yeah|yep|confirm|looks good|correct|ok|okay|go|go ahead|start|run it|do it)/i.test(rawMessage?.trim() ?? '');

    if (!isConfirmed) {
      // Treat their message as a corrected job name
      await setSession(userId, {
        awaitingRankConfirm: false,
        awaitingRankJD: true,
        pendingRankJobName: rawMessage?.trim(),
      });
      await say(`Got it — job name set to *${rawMessage?.trim()}*. Now paste the job description or scorecard.`);
      return;
    }

    await setSession(userId, { awaitingRankConfirm: false, awaitingRankJD: true });
    await say(`Perfect. Paste the job description or scorecard and I\'ll kick off the ranking.`);
    return;
  }

  // No role yet — ask
  if (!role) {
    await say("What role are you ranking candidates for?");
    await setSession(userId, { awaitingRankInput: true });
    return;
  }

  // Have role — propose job name and ask for confirmation
  const suggestedJobName = `${role}${company ? ' — ' + company : ''} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  await setSession(userId, {
    awaitingRankConfirm: true,
    awaitingRankJD: false,
    pendingRankRole: role,
    pendingRankCompany: company ?? null,
    pendingRankJobName: suggestedJobName,
    activeRole: role,
    activeCompany: company ?? null,
  });

  await say({
    text: `I'll name this ranking job: ${suggestedJobName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `I'll name this ranking job:\n\n*${suggestedJobName}*\n\nDoes that work, or would you like a different name?`
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Reply "yes" to confirm or type a different name._' }]
      }
    ]
  });
}

// LOOKUP: find and summarize a specific candidate
async function handleLookup(say, userId, entities, session) {
  const name = entities.name ?? session.lastCandidate;

  if (!name) {
    await say("Who would you like me to look up? Give me a name and I'll pull their profile.");
    await setSession(userId, { awaitingName: true });
    return;
  }

  await say(`_Looking up ${name} in Metaview..._`);

  try {
    const fieldValues = await metaviewCall('list_field_values', {
      field_id: 'default:candidate',
      report_id: reportId,
      search_term: name
    });

    if (!fieldValues?.values?.length) {
      await say(`I couldn't find anyone named *${name}* in the Candidate Interviews report. Double-check the spelling or try a partial name.`);
      return;
    }

    const match = fieldValues.values[0];
    const candidateUUID = match.value;
    const resolvedName  = match.label ?? name;

    const result = await metaviewCall('search_conversations', {
      report_id: reportId,
      fields: [...FIELD_IDS, 'default:start_time', 'default:interviewer'],
      filters: [{ field_id: 'default:candidate', operation: 'includes_one_of', value: [candidateUUID] }],
      limit: 5,
      sort_by: 'default:start_time',
      sort_ascending: false
    });

    if (!result?.conversations?.length) {
      await say(`Found *${resolvedName}* in the database but couldn't load their interviews. Try again in a moment.`);
      return;
    }

    const convs = result.conversations;
    const profiles = convs.map(c => ({
      name:             getVal(c, 'default:candidate') ?? resolvedName,
      date:             c.fields?.['default:start_time']?.[0]?.label,
      interviewer:      getVal(c, 'default:interviewer'),
      functionLevel:    getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority:        getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      playerCoach:      getVal(c, 'AI:c3997064-49be-11f1-88cd-e34aef2bf193'),
      leadershipScope:  getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
      gtm:              getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
      companyStage:     getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      industry:         getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
      dealSize:         getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
      techFluency:      getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
      crossFunctional:  getVal(c, 'AI:b76395ae-49be-11f1-b7cc-27718543b130'),
      compContext:      getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
      compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
      availability:     getVal(c, 'AI:e07de6f6-49be-11f1-a6c6-2f3b4b019285'),
      reasonForLooking: getVal(c, 'AI:07343c46-49bf-11f1-ac1a-dbf22856edfb'),
      location:         getVal(c, 'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de'),
      url: c.url,
    }));

    const p = profiles[0];
    await setSession(userId, {
      lastCandidate: resolvedName,
      lastCandidateUUID: candidateUUID,
      lastCandidateConvs: convs.map(c => c.id),
      lastCandidateProfile: { ...p, uuid: candidateUUID }
    });

    const filledFields = [p.functionLevel, p.seniority, p.playerCoach, p.leadershipScope, p.gtm, p.companyStage, p.industry, p.dealSize, p.techFluency].filter(Boolean);
    const hasData = filledFields.length >= 3;

    let summary;
    if (!hasData) {
      const interviewedBy = p.interviewer ? ` with ${p.interviewer}` : '';
      const interviewDate = p.date ? ` on ${p.date}` : '';
      summary = `Interviewed${interviewedBy}${interviewDate}. Profile fields haven't been analyzed yet — this is likely a recent interview. Review the full recording for details.`;
    } else {
      const summaryRes = await withRetry(() => anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: `You are a recruiter's assistant at SwingSearch. Write a concise candidate profile — 3-5 sentences maximum. Lead with what makes them interesting or disqualifying. Be specific and direct. Use only what's provided in the data. NEVER mention missing fields, gaps in data, or anything that "was not captured" or "not discussed" — only speak to what you know. NEVER mention a client company name, hiring company, or speculate about fit for any specific role or employer.`,
        messages: [{ role: 'user', content: `Summarize: ${JSON.stringify(p)}` }]
      }));
      summary = summaryRes.content.find(b => b.type === 'text')?.text ?? '';
    }

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${profiles[0].name ?? name}*${profiles[0].functionLevel ? `  ·  ${profiles[0].functionLevel}` : ''}` } },
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
    ];
    if (convs.length > 1) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${convs.length} interviews on file. Showing most recent._` }] });
    }

    await say({ text: `Found ${resolvedName}`, blocks });

  } catch (err) {
    console.error('Lookup error:', err?.message ?? err);
    if (err?.status === 429) {
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '60', 10);
      await say(`I'm hitting API rate limits. Try again in about ${Math.ceil(retryAfter / 60)} minute(s).`);
    } else {
      await say(`Something went wrong looking up ${name}: ${err?.message ?? 'unknown error'}`);
    }
  }
}

// FIND: natural language candidate search
async function handleFind(say, userId, entities, session) {
  const criteria = entities.criteria;

  if (!criteria) {
    await say("What are you looking for? Describe the candidate you have in mind — function, seniority, industry, GTM experience, whatever matters most.");
    await setSession(userId, { awaitingFindCriteria: true });
    return;
  }

  await say(`_Searching for ${criteria}..._`);

  try {
    const filterRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You translate recruiter search criteria into Metaview filter arrays. Return ONLY a JSON array of filter objects, no other text.

Available filter fields:
- Primary Function: field_id "AI:b04c164c-49be-11f1-9b23-674021cd80ae", operation "is_one_of", values from: ["Sales", "Marketing", "Product", "Engineering", "Operations", "Customer Success", "People / HR", "Data / Analytics", "General Management"]
- Date: field_id "default:start_time", operation "after", value must be {"scope": "relative", "value": -63072000} for 24 months

Always include the 24-month date filter. Include function filter if function is clear from criteria.

Example output: [{"field_id": "AI:b04c164c-49be-11f1-9b23-674021cd80ae", "operation": "is_one_of", "value": ["Sales"]}, {"field_id": "default:start_time", "operation": "after", "value": {"scope": "relative", "value": -63072000}}]`,
      messages: [{ role: 'user', content: criteria }]
    });

    const filterText  = filterRes.content.find(b => b.type === 'text')?.text ?? '';
    const filterMatch = filterText.match(/\[[\s\S]*\]/);
    if (!filterMatch) throw new Error('Could not parse filters from criteria');
    const filters = JSON.parse(filterMatch[0]);

    const candidates = await fetchCandidates(filters, 10);

    if (!candidates.length) {
      await say(`No candidates found matching "${criteria}" in the last 24 months.`);
      return;
    }

    const profiles = candidates.map((c, i) => ({
      index: i,
      name:          getVal(c, 'default:candidate') ?? `Candidate ${i+1}`,
      url:           c.url,
      functionLevel: getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority:     getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      leadershipScope: getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
      gtm:           getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
      companyStage:  getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      industry:      getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
      dealSize:      getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
      techFluency:   getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
    }));

    const CHUNK = 80;
    let topMatches = [];
    for (let i = 0; i < profiles.length; i += CHUNK) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      const chunk = profiles.slice(i, i + CHUNK);
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `You are a recruiter's assistant at SwingSearch. Find the top candidates matching search criteria. Return ONLY valid JSON — no markdown.

Output: {"matches": [{"index": <n>, "score": <0-100>, "reason": "<one sentence why they match>"}]}

Only include candidates with score >= 60. Maximum 8 candidates. Be selective and opinionated.`,
        messages: [{ role: 'user', content: `SEARCH CRITERIA: ${criteria}\n\nCANDIDATES: ${JSON.stringify(chunk, null, 2)}` }]
      });

      const text = res.content.find(b => b.type === 'text')?.text ?? '';
      const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        topMatches = topMatches.concat(parsed.matches ?? []);
      }
    }

    topMatches = topMatches.sort((a, b) => b.score - a.score).slice(0, 8);

    if (!topMatches.length) {
      await say(`Found ${candidates.length} candidates in that function but none scored above 60% match for "${criteria}". Try broader criteria.`);
      return;
    }

    await setSession(userId, { lastSearch: criteria, lastResults: topMatches.map(m => profiles[m.index]?.name) });

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `🔍 Top matches for: ${criteria.slice(0, 60)}`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${topMatches.length} matches from the ${candidates.length} most recent candidates · _Say "search deeper" to look further back_` }] },
      { type: 'divider' },
    ];

    topMatches.forEach((m, i) => {
      const p = profiles[m.index];
      if (!p) return;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${i+1}. ${p.url ? `<${p.url}|${p.name}>` : p.name}*${p.functionLevel ? `  ·  ${p.functionLevel}` : ''}\n${m.reason}` }
      });
      if (i < topMatches.length - 1) blocks.push({ type: 'divider' });
    });

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Say "tell me more about [name]" for a deeper profile on any candidate._` }] });
    await say({ text: `Found ${topMatches.length} matches`, blocks });

  } catch (err) {
    console.error('Find error:', err);
    await say(`Something went wrong with that search. ${err.message}`);
  }
}

// HELP
async function handleHelp(say) {
  await say({
    text: 'Here\'s what I can do',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'CandiBot — What I can do', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '*🔍 Find candidates*\nDescribe what you\'re looking for in plain English.\n_"Find me VP Sales candidates with enterprise SaaS experience"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*👤 Look up a candidate*\nGet a quick profile on anyone we\'ve screened.\n_"Pull up Indy Sen"_ or _"Tell me about Sarah Lee"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📊 Rank candidates*\nScore your full pipeline against a role or JD — runs fully in the background, results post here as a link.\n_"Rank candidates for the VP Sales role at AmberBox"_\nI\'ll confirm the job name, then ask for the JD.' } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Say "reset" to clear context and start fresh._' }] },
    ]
  });
}

// FOLLOWUP
async function handleFollowup(say, userId, message, session) {
  const profile = session.lastCandidateProfile;
  const name    = session.lastCandidate;

  if (!profile || !name) {
    await say("I don't have a candidate in context. Who would you like to know more about?");
    return;
  }

  const isCompQuestion = /comp|salary|pay|compensation|making|earn|expectation/i.test(message);
  let compData = null;

  if (isCompQuestion) {
    try {
      const compResult = await metaviewCall('search_conversations', {
        report_id: reportId,
        fields: ['default:candidate', 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2', 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'],
        filters: [{ field_id: 'default:candidate', operation: 'includes_one_of', value: [profile.uuid ?? session.lastCandidateUUID] }],
        limit: 1,
        sort_by: 'default:start_time',
        sort_ascending: false
      });
      if (compResult?.conversations?.[0]) {
        const c = compResult.conversations[0];
        compData = {
          compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
          compContext:      getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
        };
      }
    } catch (e) { console.error('Comp fetch error:', e.message); }
  }

  const profileWithComp = compData ? { ...profile, ...compData } : profile;

  const res = await withRetry(() => anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `You are a recruiter's assistant at SwingSearch. Answer the specific question asked about a candidate using only the data provided. Be direct and concise — 1-3 sentences. If the data doesn't contain the answer, say so plainly. Never mention client or employer names.`,
    messages: [{ role: 'user', content: `Candidate profile: ${JSON.stringify(profileWithComp)}\n\nQuestion: ${message}` }]
  }));

  const answer = res.content.find(b => b.type === 'text')?.text ?? '';
  await say(answer);
}

// DEEPER
async function handleDeeper(say, userId, session) {
  const criteria = session.lastSearch;
  if (!criteria) {
    await say("No recent search to go deeper on. What are you looking for?");
    return;
  }

  await say(`_Searching deeper for "${criteria}"..._`);

  try {
    const filterRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You translate recruiter search criteria into Metaview filter arrays. Return ONLY a JSON array of filter objects.
Available filters:
- Primary Function: field_id "AI:b04c164c-49be-11f1-9b23-674021cd80ae", operation "is_one_of", values from: ["Sales", "Marketing", "Product", "Engineering", "Operations", "Customer Success", "People / HR", "Data / Analytics", "General Management"]
- Date: field_id "default:start_time", operation "after", value {"scope": "relative", "value": -63072000}
Always include the date filter.`,
      messages: [{ role: 'user', content: criteria }]
    });

    const filterText  = filterRes.content.find(b => b.type === 'text')?.text ?? '';
    const filterMatch = filterText.match(/\[[\s\S]*\]/);
    if (!filterMatch) throw new Error('Could not parse filters');
    const filters = JSON.parse(filterMatch[0]);

    const allCandidates    = await fetchCandidates(filters, 20);
    const deeperCandidates = allCandidates.slice(500);

    if (!deeperCandidates.length) {
      await say("No additional candidates found beyond what was already shown.");
      return;
    }

    const profiles = deeperCandidates.map((c, i) => ({
      index: i,
      name:            getVal(c, 'default:candidate') ?? `Candidate ${i+1}`,
      url:             c.url,
      functionLevel:   getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority:       getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      leadershipScope: getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
      gtm:             getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
      companyStage:    getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      industry:        getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
      dealSize:        getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
      techFluency:     getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
      location:        getVal(c, 'AI:23a0a5ca-0844-11f1-a762-fff4ba5db7de'),
    }));

    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: `Find the top candidates matching search criteria from an older pool. Return ONLY valid JSON.
Output: {"matches": [{"index": <n>, "score": <0-100>, "reason": "<one sentence>"}]}
Only include candidates with score >= 60. Maximum 8 candidates.`,
      messages: [{ role: 'user', content: `SEARCH: ${criteria}\n\nCANDIDATES: ${JSON.stringify(profiles.slice(0, 80), null, 2)}` }]
    });

    const text = res.content.find(b => b.type === 'text')?.text ?? '';
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) { await say("No additional matches found in the deeper search."); return; }

    const parsed     = JSON.parse(match[0]);
    const topMatches = (parsed.matches ?? []).sort((a, b) => b.score - a.score).slice(0, 8);

    if (!topMatches.length) { await say("No additional matches found beyond the initial results."); return; }

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `🔍 Deeper results: ${criteria.slice(0, 50)}`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${topMatches.length} additional matches from older candidates` }] },
      { type: 'divider' },
    ];

    topMatches.forEach((m, i) => {
      const p = profiles[m.index];
      if (!p) return;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${i+1}. ${p.url ? `<${p.url}|${p.name}>` : p.name}*${p.functionLevel ? `  ·  ${p.functionLevel}` : ''}\n${m.reason}` } });
      if (i < topMatches.length - 1) blocks.push({ type: 'divider' });
    });

    await say({ text: `Found ${topMatches.length} deeper matches`, blocks });

  } catch (err) {
    console.error('Deeper search error:', err);
    await say(`Something went wrong: ${err.message}`);
  }
}

// ── Main message router ───────────────────────────────────────────────────────
async function routeMessage(say, userId, text) {
  const session = await getSession(userId);
  const { intent, entities } = await detectIntent(text, session);
  console.log(`User ${userId} intent: ${intent}`, entities);

  // Handle pending rank confirmation/JD states before normal routing
  if (session.awaitingRankConfirm || session.awaitingRankJD) {
    await handleRank(say, userId, entities, session, text);
    return;
  }

  switch (intent) {
    case INTENTS.DEEPER:
      await handleDeeper(say, userId, session);
      break;
    case INTENTS.FOLLOWUP:
      await handleFollowup(say, userId, text, session);
      break;
    case INTENTS.RANK:
      await handleRank(say, userId, entities, session, text);
      break;
    case INTENTS.LOOKUP:
    case INTENTS.SUMMARIZE:
      await handleLookup(say, userId, entities, session);
      break;
    case INTENTS.FIND:
      await handleFind(say, userId, entities, session);
      break;
    case INTENTS.RESET:
      await clearSession(userId);
      await say("Context cleared. What are we working on?");
      break;
    case INTENTS.HELP:
      await handleHelp(say);
      break;
    default:
      if (session.awaitingRankInput) {
        await setSession(userId, { awaitingRankInput: false });
        await handleRank(say, userId, { ...entities, role: entities.role ?? text }, session, text);
      } else if (session.awaitingName) {
        await setSession(userId, { awaitingName: false });
        await handleLookup(say, userId, { name: text }, session);
      } else if (session.awaitingFindCriteria) {
        await setSession(userId, { awaitingFindCriteria: false });
        await handleFind(say, userId, { criteria: text }, session);
      } else {
        await say("I didn't quite get that. Try asking me to find candidates, look someone up, or rank your pipeline — or say *help* to see everything I can do.");
      }
  }
}

// ── Slack app (Socket Mode) ───────────────────────────────────────────────────
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
});

slackApp.message(async ({ message, say }) => {
  if (message.bot_id || message.subtype) return;
  const text = message.text?.trim();
  if (!text) return;
  try {
    await routeMessage(say, message.user, text);
  } catch (err) {
    console.error('Message handler error:', err);
    if (err.status === 429) {
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '60', 10);
      await say(`I'm hitting API rate limits right now. Try again in about ${Math.ceil(retryAfter / 60)} minute(s).`);
    } else {
      await say("Something went wrong on my end. Try again in a moment.");
    }
  }
});

slackApp.command('/candibot-help', async ({ ack, say }) => {
  await ack();
  await handleHelp(say);
});

// ── Express ───────────────────────────────────────────────────────────────────
const expressApp = express();
expressApp.use(express.json());

expressApp.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Job status polling — artifact calls this to check if ranking is done
expressApp.get('/job/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ranking page
expressApp.get('/ranking/:id', async (req, res) => {
  try {
    const data = await getRanking(req.params.id);
    if (!data) return res.status(404).send('<h2 style="font-family:sans-serif;padding:40px">Ranking not found or expired.</h2>');
    res.set('Content-Type', 'text/html').send(buildRankingHTML(data));
  } catch (e) {
    console.error('Ranking fetch error:', e);
    res.status(500).send('<h2 style="font-family:sans-serif;padding:40px">Error loading ranking.</h2>');
  }
});

// Ranking auth endpoint — checks password server-side, never exposes it in page source
expressApp.post('/ranking/:id/auth', async (req, res) => {
  try {
    const { password } = req.body;
    const ok = password === RANKING_PASSWORD;
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Save ranking — kept for backward compatibility with artifact
expressApp.post('/save-ranking', async (req, res) => {
  try {
    const { ranked, jdSnippet } = req.body;
    if (!ranked?.length) return res.status(400).json({ error: 'No ranked candidates provided' });
    const id = crypto.randomBytes(8).toString('hex');
    await saveRanking(id, { jdSnippet, createdAt: new Date().toISOString(), ranked });
    res.json({ url: `${PUBLIC_URL}/ranking/${id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

expressApp.listen(PORT, () => console.log(`Express server on port ${PORT}`));

// ── Hosted ranking HTML ───────────────────────────────────────────────────────
function buildRankingHTML(rankingData) {
  const { jdSnippet, createdAt, ranked } = rankingData;
  const strong   = ranked.filter(r => r.tier === 'Strong Fit');
  const possible = ranked.filter(r => r.tier === 'Possible Fit');

  const tierColor  = { 'Strong Fit': '#1B7A4A', 'Possible Fit': '#9B6C1A' };
  const tierBg     = { 'Strong Fit': 'rgba(27,122,74,0.08)', 'Possible Fit': 'rgba(200,150,30,0.08)' };
  const tierBorder = { 'Strong Fit': 'rgba(27,122,74,0.25)', 'Possible Fit': 'rgba(200,150,30,0.25)' };

  function cardHTML(r, rank) {
    const tc  = tierColor[r.tier]  ?? '#9B6C1A';
    const tb  = tierBg[r.tier]    ?? 'rgba(200,150,30,0.08)';
    const tbd = tierBorder[r.tier] ?? 'rgba(200,150,30,0.25)';
    const strengths = (r.strengths ?? []).map(s => `<div class="bullet green">+ ${s}</div>`).join('');
    const gaps = (r.gaps ?? []).length
      ? (r.gaps ?? []).map(g => `<div class="bullet rose">– ${g}</div>`).join('')
      : '<div style="color:#B0BEC9;font-size:12px">None identified</div>';
    const details = [
      ['Seniority', r.seniority], ['Player/Coach', r.playerCoach], ['Leadership Scope', r.leadershipScope],
      ['Company Stage', r.companyStage], ['GTM', r.gtm], ['Deal Size', r.dealSize],
      ['Tech Fluency', r.techFluency], ['Industry', r.industry],
    ].filter(([,v]) => v).map(([l, v]) => `<div><div class="dl">${l}</div><div class="dv">${v}</div></div>`).join('');

    return `<div class="card" style="border-left-color:${tc}" onclick="toggleCard(this)">
      <div class="ch">
        <div class="rank">#${rank}</div>
        <div class="score" style="color:${tc};background:${tb};border-color:${tbd}">${r.score}</div>
        <div class="cm">
          <div class="nr">${r.url ? `<a href="${r.url}" target="_blank" onclick="event.stopPropagation()" class="nl">${r.name}</a>` : `<span class="nm">${r.name}</span>`}${r.functionLevel ? `<span class="mt">${r.functionLevel}</span>` : ''}</div>
          <div class="hl">${r.headline}</div>
        </div>
        <div class="tp" style="color:${tc};background:${tb};border-color:${tbd}">${r.tier}</div>
        <div class="cv">▾</div>
      </div>
      <div class="cd">
        <div class="sg"><div><div class="sl green-l">Strengths</div>${strengths}</div><div><div class="sl rose-l">Gaps</div>${gaps}</div></div>
        ${r.note ? `<div class="nb"><div class="dl">Recruiter Note</div><div style="font-size:13px;color:#2C3E55;line-height:1.6">${r.note}</div></div>` : ''}
        <div class="dg">${details}</div>
        ${r.url ? `<div class="cf"><a href="${r.url}" target="_blank" class="mvl">View in Metaview →</a></div>` : ''}
      </div>
    </div>`;
  }

  function sectionHTML(tier, candidates, startRank) {
    if (!candidates.length) return '';
    return `<div class="ts">
      <div class="th" onclick="toggleSection(this)">
        <div style="height:1px;width:24px;background:${tierBorder[tier]};flex-shrink:0"></div>
        <div class="tt" style="color:${tierColor[tier]}">${tier}</div>
        <div class="tc">(${candidates.length})</div>
        <div style="flex:1;height:1px;background:#F0F4F8"></div>
        <div class="tch">▾</div>
      </div>
      <div class="tb">${candidates.map((r, i) => cardHTML(r, startRank + i)).join('')}</div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate Ranking — SwingSearch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Lato',sans-serif;background:#F7F9FC;color:#1B2B4B;min-height:100vh}a{color:inherit;text-decoration:none}
#ao{position:fixed;inset:0;background:#1B2B4B;display:flex;align-items:center;justify-content:center;z-index:100}
.ab{background:#fff;border-radius:12px;padding:40px;width:360px;text-align:center}
.al{font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:#1B2B4B;margin-bottom:4px}
.as{font-size:12px;color:#8899AA;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px}
.ai{width:100%;border:1px solid #DDE4EE;border-radius:6px;padding:10px 14px;font-size:14px;font-family:'Lato',sans-serif;color:#1B2B4B;margin-bottom:12px}
.ai:focus{outline:none;border-color:#C8456C}
.abtn{width:100%;background:#C8456C;color:#fff;border:none;border-radius:6px;padding:11px;font-size:13px;font-family:'Lato',sans-serif;font-weight:700;cursor:pointer}
.aerr{font-size:12px;color:#C8456C;margin-top:8px;display:none}
.hdr{background:#1B2B4B;padding:18px 40px;display:flex;align-items:center;justify-content:space-between}
.br{font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:#fff}
.sep{color:rgba(255,255,255,.3);font-size:14px;margin:0 14px}
.pt{font-size:12px;color:rgba(255,255,255,.5);letter-spacing:.1em;text-transform:uppercase}
.ebtn{background:transparent;border:1px solid rgba(200,69,108,.6);color:#C8456C;border-radius:6px;padding:7px 16px;font-size:12px;font-family:'Lato',sans-serif;cursor:pointer;font-weight:700;letter-spacing:.05em}
.main{max-width:880px;margin:0 auto;padding:40px 24px 80px}
.sm{padding-bottom:24px;border-bottom:1px solid #E8EDF3;margin-bottom:32px}
.se{font-size:11px;color:#8899AA;letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px}
.st{font-family:'Playfair Display',serif;font-size:18px;color:#1B2B4B;font-weight:600;margin-bottom:8px}
.sd{font-size:11px;color:#B0BEC9;margin-bottom:16px}
.ss{display:flex;gap:28px}
.sn{font-family:'Playfair Display',serif;font-size:26px;font-weight:700}
.sl2{font-size:11px;color:#8899AA;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.ts{margin-bottom:32px}
.th{display:flex;align-items:center;gap:12px;margin-bottom:12px;cursor:pointer;user-select:none}
.tt{font-family:'Playfair Display',serif;font-size:16px;font-weight:600}
.tc{font-size:12px;color:#B0BEC9}
.tch{font-size:11px;color:#B0BEC9;transition:transform .2s}
.th.collapsed .tch{transform:rotate(-90deg)}
.tb.hidden{display:none}
.card{background:#fff;border:1px solid #E8EDF3;border-left:3px solid;border-radius:8px;margin-bottom:8px;overflow:hidden;transition:box-shadow .2s;cursor:pointer}
.card:hover{box-shadow:0 4px 16px rgba(27,43,75,.08)}
.ch{padding:14px 18px;display:flex;align-items:center;gap:14px}
.rank{font-size:11px;color:#B0BEC9;width:22px;text-align:right;flex-shrink:0}
.score{border-radius:6px;border:1px solid;padding:3px 10px;font-size:14px;font-weight:700;flex-shrink:0;min-width:40px;text-align:center}
.cm{flex:1;min-width:0}
.nr{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.nl{font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:#1B2B4B;border-bottom:1px solid #C8456C}
.nm{font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:#1B2B4B}
.mt{font-size:11px;color:#8899AA}
.hl{font-size:12px;color:#677A8E;margin-top:3px;line-height:1.5}
.tp{border-radius:20px;border:1px solid;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;flex-shrink:0}
.cv{color:#B0BEC9;font-size:12px;transition:transform .2s;flex-shrink:0}
.card.open .cv{transform:rotate(180deg)}
.cd{display:none;padding:0 18px 18px 54px;border-top:1px solid #F0F4F8}
.card.open .cd{display:block}
.sg{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;margin-bottom:16px}
.sl{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:8px}
.green-l{color:#1B7A4A}.rose-l{color:#C8456C}
.bullet{font-size:12px;color:#2C3E55;margin-bottom:6px;padding-left:14px;position:relative;line-height:1.55}
.bullet.green::before{content:'+';position:absolute;left:0;color:#1B7A4A;font-weight:700}
.bullet.rose::before{content:'–';position:absolute;left:0;color:#C8456C;font-weight:700}
.nb{background:rgba(27,43,75,.04);border:1px solid rgba(27,43,75,.08);border-radius:6px;padding:10px 14px;margin-bottom:16px}
.dg{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 24px}
.dl{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8899AA;font-weight:700;margin-bottom:3px}
.dv{font-size:13px;color:#2C3E55;line-height:1.5}
.cf{margin-top:14px;border-top:1px solid #F0F4F8;padding-top:12px}
.mvl{color:#C8456C;font-size:11px}
@media(max-width:600px){.hdr{padding:14px 16px}.main{padding:24px 16px 60px}.sg,.dg{grid-template-columns:1fr}.tp{display:none}.ss{gap:16px}}
</style>
</head>
<body>
<div id="ao">
  <div class="ab">
    <div class="al">SwingSearch</div>
    <div class="as">Candidate Ranking</div>
    <input id="pw" type="password" placeholder="Team password" class="ai" onkeydown="if(event.key==='Enter')auth()">
    <button class="abtn" onclick="auth()">View Rankings</button>
    <div id="ae" class="aerr">Incorrect password</div>
  </div>
</div>
<div class="hdr">
  <div style="display:flex;align-items:center">
    <span class="br">SwingSearch</span><span class="sep">/</span><span class="pt">Candidate Ranking</span>
  </div>
  <button class="ebtn" onclick="exportCSV()">Export CSV</button>
</div>
<div class="main" id="mc" style="display:none">
  <div class="sm">
    <div class="se">Ranked against</div>
    <div class="st">${jdSnippet}</div>
    <div class="sd">Generated ${new Date(createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · Expires in 30 days</div>
    <div class="ss">
      <div><div class="sn" style="color:#1B2B4B">${ranked.length}</div><div class="sl2">Total</div></div>
      <div><div class="sn" style="color:#1B7A4A">${strong.length}</div><div class="sl2">Strong Fit</div></div>
      <div><div class="sn" style="color:#9B6C1A">${possible.length}</div><div class="sl2">Possible Fit</div></div>
    </div>
  </div>
  ${sectionHTML('Strong Fit', strong, 1)}
  ${sectionHTML('Possible Fit', possible, strong.length + 1)}
</div>
<script>
// Password is checked server-side via hash comparison — never exposed in page source
const SK = 'ss_auth_v2';

function unlock() {
  document.getElementById('ao').style.display = 'none';
  document.getElementById('mc').style.display = 'block';
}

async function auth() {
  const v = document.getElementById('pw').value.trim();
  if (!v) return;
  const btn = document.querySelector('.abtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch(window.location.pathname + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: v })
    });
    const data = await res.json();
    if (data.ok) {
      sessionStorage.setItem(SK, '1');
      unlock();
    } else {
      document.getElementById('ae').style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'View Rankings';
    }
  } catch (e) {
    document.getElementById('ae').textContent = 'Network error — try again.';
    document.getElementById('ae').style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'View Rankings';
  }
}

document.getElementById('pw').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') auth();
});

if (sessionStorage.getItem(SK) === '1') { unlock(); }

function toggleCard(c) { c.classList.toggle('open'); }
function toggleSection(h) { h.classList.toggle('collapsed'); h.nextElementSibling.classList.toggle('hidden'); }

const ranked = ${JSON.stringify(ranked)};

function exportCSV() {
  const h = ['Rank','Name','Score','Tier','Function & Level','Seniority','Player/Coach','Company Stage','GTM','Deal Size','Tech Fluency','Industry','Headline','Strengths','Gaps','Link'];
  const r = ranked.map((c,i) => [i+1,c.name,c.score,c.tier,c.functionLevel??'',c.seniority??'',c.playerCoach??'',c.companyStage??'',c.gtm??'',c.dealSize??'',c.techFluency??'',c.industry??'','"'+(c.headline??'').replace(/"/g,'""')+'"','"'+(c.strengths??[]).join('; ').replace(/"/g,'""')+'"','"'+(c.gaps??[]).join('; ').replace(/"/g,'""')+'"',c.url??'']);
  const csv = [h,...r].map(x => x.join(',')).join('\n');
  const b = new Blob([csv],{type:'text/csv'}); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href=u; a.download='ranking.csv'; a.click(); URL.revokeObjectURL(u);
}
</script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await slackApp.start();
  console.log('CandiBot is running (Socket Mode)');
})();
