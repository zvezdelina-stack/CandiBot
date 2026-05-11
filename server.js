import pkg from '@slack/bolt';
const { App } = pkg;
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import express from 'express';
import https from 'https';

// ── Env ───────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN        = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN        = process.env.SLACK_APP_TOKEN;
const SLACK_SIGNING_SECRET   = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY       = process.env.METAVIEW_API_KEY;
const RANKING_PASSWORD       = process.env.RANKING_PASSWORD;
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUBLIC_URL             = process.env.PUBLIC_URL || 'https://candibot-production.up.railway.app';
const PORT                   = process.env.PORT || 8080;

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// ── Retry wrapper ────────────────────────────────────────────────────────────
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

// ── Config ────────────────────────────────────────────────────────────────────
const REPORT_ID = '61729db2-3946-11f1-b952-fb44be0b5cdb';
const RANKING_TTL  = 30 * 24 * 60 * 60; // 30 days in seconds
const SESSION_TTL  = 60 * 60;            // 1 hour in seconds
const MCP_SERVERS  = [{ type: 'url', url: 'https://mcp.metaview.ai/mcp', name: 'metaview', authorization_token: METAVIEW_API_KEY }];

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
];

// ── Session management ────────────────────────────────────────────────────────
// Stores per-user context: active search, last candidate discussed, etc.
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

// ── Intent detection ──────────────────────────────────────────────────────────
const INTENTS = {
  RANK:       'rank',       // "rank candidates for this VP Sales role"
  FIND:       'find',       // "find me engineers with fintech background"
  LOOKUP:     'lookup',     // "pull up John Smith" / "tell me about Sarah Lee"
  FOLLOWUP:   'followup',   // "what was their comp?" / "tell me more about their GTM experience"
  SUMMARIZE:  'summarize',  // "summarize the last 5 sales calls"
  HELP:       'help',       // "help" / "what can you do"
  RESET:      'reset',      // "start over" / "reset"
  DEEPER:     'deeper',     // "search deeper" / "look further back"
  UNKNOWN:    'unknown',
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
- followup: user is asking a follow-up question about the last candidate discussed (e.g. "what was their comp?", "what about their GTM experience?", "how much were they making?", "did they discuss availability?") — use this when there's a candidate in session context and no new name is mentioned
- summarize: user wants a summary of conversations or a candidate
- help: user wants to know what the bot can do
- reset: user wants to clear context and start fresh
- deeper: user wants to search further back in the candidate database after a find query (e.g. "search deeper", "look further back", "check older candidates")
- unknown: none of the above

Entities to extract:
- name: candidate name if mentioned
- role: job title or function if mentioned
- criteria: any search criteria mentioned
- jd: job description text if pasted (long text)

Current session context: ${JSON.stringify(session)}

Return format: {"intent": "rank", "entities": {"role": "VP Sales", "jd": null}}`,
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

// Run a single Metaview MCP call via Claude and extract the tool result
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

// Fetch all candidates matching filters, paginating server-side
async function fetchCandidates(filters, maxPages = Infinity) {
  let all = [], offset = 0, hasMore = true, page = 0;

  while (hasMore && page < maxPages) {
    page++;
    console.log(`Fetching page ${page} (offset ${offset})...`);

    const result = await metaviewCall('search_conversations', {
      report_id: REPORT_ID,
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

    // No delay for sourcing queries — speed matters more than rate limit caution here
  }

  return all;
}

// ── Intent handlers ───────────────────────────────────────────────────────────

// RANK: confirm function/level then hand off to Claude artifact
async function handleRank(say, userId, entities, session) {
  const role = entities.role ?? session.activeRole;
  const jd   = entities.jd;

  // If we have a JD pasted directly, save it to session and proceed
  if (jd && jd.length > 100) {
    await setSession(userId, { pendingJD: jd, pendingRole: role });
    await say({
      text: `Got it. Before I open the ranker, let me confirm the search criteria.`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `📋 *Ranking request received*\n\nI'll open the SwingSearch Candidate Ranker for you. Paste the same JD there to run the full ranking — it's faster and handles the full candidate pool.\n\n*<https://claude.ai|Open Claude →>* then find the Candidate Ranker conversation.\n\nOnce the ranking is complete the results will be saved and I'll post the link here.` }
        }
      ]
    });
    return;
  }

  // If no JD yet, ask for it
  if (!role && !jd) {
    await say("What role are you ranking candidates for? You can paste a job description or just describe the key criteria.");
    await setSession(userId, { awaitingRankInput: true });
    return;
  }

  // We have a role but no JD — confirm and ask for more detail
  await say(`Got it — ranking for *${role}*. Paste the full job description or scorecard and I'll open the ranker for you.`);
  await setSession(userId, { activeRole: role, awaitingRankInput: true });
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
    // Step 1: resolve name to participant UUID via list_field_values
    const fieldValues = await metaviewCall('list_field_values', {
      field_id: 'default:candidate',
      report_id: REPORT_ID,
      search_term: name
    });

    if (!fieldValues?.values?.length) {
      await say(`I couldn't find anyone named *${name}* in the Candidate Interviews report. Double-check the spelling or try a partial name.`);
      return;
    }

    // Use the first match — pick the closest name if multiple
    const match = fieldValues.values[0];
    const candidateUUID = match.value;
    const resolvedName = match.label ?? name;

    // Step 2: fetch conversations for that candidate
    const result = await metaviewCall('search_conversations', {
      report_id: REPORT_ID,
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

    // Build a summary using Claude
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

    // Check if we have meaningful data to summarize
    const p = profiles[0];

    // Save to session now that profiles is defined
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
      // Not enough AI field data — give a direct response without padding
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
    console.error('Lookup error full:', err?.message ?? err);
    console.error('Lookup error stack:', err?.stack);
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
    // Use Claude to translate criteria into Metaview filters
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

    const filterText = filterRes.content.find(b => b.type === 'text')?.text ?? '';
    const filterMatch = filterText.match(/\[[\s\S]*\]/);
    if (!filterMatch) throw new Error('Could not parse filters from criteria');
    const filters = JSON.parse(filterMatch[0]);

    const candidates = await fetchCandidates(filters, 10); // Cap at 500 candidates for sourcing

    if (!candidates.length) {
      await say(`No candidates found matching "${criteria}" in the last 24 months.`);
      return;
    }

    // Score and filter top matches using Claude
    const profiles = candidates.map((c, i) => ({
      index: i,
      name: getVal(c, 'default:candidate') ?? `Candidate ${i+1}`,
      url: c.url,
      functionLevel: getVal(c, 'AI:e30fda36-49a1-11f1-8c8c-0be86f9f735e'),
      seniority: getVal(c, 'AI:ce5f35c4-49be-11f1-b134-8386e8f8aa46'),
      leadershipScope: getVal(c, 'AI:917f01a2-49be-11f1-8173-9b81bcb7b69d'),
      gtm: getVal(c, 'AI:9e23828e-49be-11f1-b88f-1b4a993d7d7e'),
      companyStage: getVal(c, 'AI:a9150424-49be-11f1-8e19-179706228ab0'),
      industry: getVal(c, 'AI:ffcd1fa4-49be-11f1-a302-239193bb599f'),
      dealSize: getVal(c, 'AI:ed14d7b2-49be-11f1-aa4c-c33869b423a9'),
      techFluency: getVal(c, 'AI:f8fd55a4-49be-11f1-a6b2-c3e5ce0f9915'),
    }));

    // Chunk if large
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

    // Sort and take top 8
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
        text: {
          type: 'mrkdwn',
          text: `*${i+1}. ${p.url ? `<${p.url}|${p.name}>` : p.name}*${p.functionLevel ? `  ·  ${p.functionLevel}` : ''}\n${m.reason}`
        }
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

// HELP: show capabilities
async function handleHelp(say) {
  await say({
    text: 'Here\'s what I can do',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'CandiBot — What I can do', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '*🔍 Find candidates*\nDescribe what you\'re looking for in plain English.\n_"Find me VP Sales candidates with enterprise SaaS experience"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*👤 Look up a candidate*\nGet a quick profile on anyone we\'ve screened.\n_"Pull up Indy Sen"_ or _"Tell me about Sarah Lee"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📊 Rank your pipeline*\nScore candidates against a job description or scorecard. Paste the full JD or key criteria and I\'ll open the Claude ranker — results post back here as a shareable link.\n_"Rank candidates for VP Sales at AmberBox"_\n_"Here\'s the scorecard: [paste]"_' } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Say "reset" to clear context and start fresh._' }] },
    ]
  });
}

// ── Follow-up question handler ───────────────────────────────────────────────
async function handleFollowup(say, userId, message, session) {
  const profile = session.lastCandidateProfile;
  const name = session.lastCandidate;

  if (!profile || !name) {
    await say("I don't have a candidate in context. Who would you like to know more about?");
    return;
  }

  // Also pull comp expectations field which isn't in the main FIELD_IDS
  // Fetch it fresh if asked about comp
  const isCompQuestion = /comp|salary|pay|compensation|making|earn|expectation/i.test(message);
  let compData = null;

  if (isCompQuestion) {
    try {
      const compResult = await metaviewCall('search_conversations', {
        report_id: REPORT_ID,
        fields: [
          'default:candidate',
          'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2', // Compensation Expectations
          'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042', // Comp Context
        ],
        filters: [{ field_id: 'default:candidate', operation: 'includes_one_of', value: [profile.uuid ?? session.lastCandidateUUID] }],
        limit: 1,
        sort_by: 'default:start_time',
        sort_ascending: false
      });
      if (compResult?.conversations?.[0]) {
        const c = compResult.conversations[0];
        compData = {
          compExpectations: getVal(c, 'AI:ae6a2b14-0eed-11f0-8f5a-d3c7fd51bce2'),
          compContext: getVal(c, 'AI:da2d2f1e-49be-11f1-ad67-ef5324fa4042'),
        };
      }
    } catch (e) {
      console.error('Comp fetch error:', e.message);
    }
  }

  const profileWithComp = compData ? { ...profile, ...compData } : profile;

  const res = await withRetry(() => anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `You are a recruiter's assistant at SwingSearch. Answer the specific question asked about a candidate using only the data provided. Be direct and concise — 1-3 sentences. If the data doesn't contain the answer, say so plainly without padding. Never mention client or employer names.`,
    messages: [{
      role: 'user',
      content: `Candidate profile: ${JSON.stringify(profileWithComp)}

Question: ${message}`
    }]
  }));

  const answer = res.content.find(b => b.type === 'text')?.text ?? '';
  await say(answer);
}

// ── Deeper search handler ────────────────────────────────────────────────────
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

    const filterText = filterRes.content.find(b => b.type === 'text')?.text ?? '';
    const filterMatch = filterText.match(/\[[\s\S]*\]/);
    if (!filterMatch) throw new Error('Could not parse filters');
    const filters = JSON.parse(filterMatch[0]);

    // Fetch pages 3-6 (candidates 101-300) — skipping what was already shown
    const allCandidates = await fetchCandidates(filters, 20);
    const deeperCandidates = allCandidates.slice(500); // Skip first 500 already shown

    if (!deeperCandidates.length) {
      await say("No additional candidates found beyond what was already shown.");
      return;
    }

    const profiles = deeperCandidates.map((c, i) => ({
      index: i,
      name: getVal(c, 'default:candidate') ?? `Candidate ${i+1}`,
      url: c.url,
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
      messages: [{ role: 'user', content: `SEARCH: ${criteria}

CANDIDATES: ${JSON.stringify(profiles.slice(0, 80), null, 2)}` }]
    });

    const text = res.content.find(b => b.type === 'text')?.text ?? '';
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) { await say("No additional matches found in the deeper search."); return; }

    const parsed = JSON.parse(match[0]);
    const topMatches = (parsed.matches ?? []).sort((a, b) => b.score - a.score).slice(0, 8);

    if (!topMatches.length) {
      await say(`No additional matches found beyond the initial results.`);
      return;
    }

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `🔍 Deeper results: ${criteria.slice(0, 50)}`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${topMatches.length} additional matches from older candidates` }] },
      { type: 'divider' },
    ];

    topMatches.forEach((m, i) => {
      const p = profiles[m.index];
      if (!p) return;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${i+1}. ${p.url ? `<${p.url}|${p.name}>` : p.name}*${p.functionLevel ? `  ·  ${p.functionLevel}` : ''}
${m.reason}` }
      });
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
  // Load session
  const session = await getSession(userId);

  // Detect intent
  const { intent, entities } = await detectIntent(text, session);
  console.log(`User ${userId} intent: ${intent}`, entities);

  // Route to handler
  switch (intent) {
    case INTENTS.DEEPER:
      await handleDeeper(say, userId, session);
      break;
    case INTENTS.FOLLOWUP:
      await handleFollowup(say, userId, text, session);
      break;
    case INTENTS.RANK:
      await handleRank(say, userId, entities, session);
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
      // Check if we're awaiting specific input from a previous turn
      if (session.awaitingRankInput) {
        await setSession(userId, { awaitingRankInput: false });
        await handleRank(say, userId, { ...entities, jd: text.length > 100 ? text : null, role: entities.role ?? text }, session);
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

// Handle all DMs
slackApp.message(async ({ message, say }) => {
  if (message.bot_id || message.subtype) return;
  const text = message.text?.trim();
  if (!text) return;

  // Acknowledge immediately, then process
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

// /help slash command
slackApp.command('/candibot-help', async ({ ack, say }) => {
  await ack();
  await handleHelp(say);
});

// ── Hosted ranking page (Express, separate port) ──────────────────────────────
// Railway exposes one public port — we use the same process but a separate
// internal HTTP server for serving hosted ranking pages.
const expressApp = express();
expressApp.use(express.json());

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

// Save ranking endpoint — called by the Claude artifact
expressApp.post('/save-ranking', express.json(), async (req, res) => {
  try {
    const { ranked, jdSnippet } = req.body;
    if (!ranked?.length) return res.status(400).json({ error: 'No ranked candidates provided' });
    const id = crypto.randomBytes(8).toString('hex');
    await saveRanking(id, { jdSnippet, createdAt: new Date().toISOString(), ranked });
    res.json({ url: `${PUBLIC_URL}/ranking/${id}` });
  } catch (e) {
    console.error('Save ranking error:', e);
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
    const tc = tierColor[r.tier] ?? '#9B6C1A';
    const tb = tierBg[r.tier] ?? 'rgba(200,150,30,0.08)';
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
const PW=${JSON.stringify(RANKING_PASSWORD)};
const SK='ss_auth';
function auth(){const v=document.getElementById('pw').value;if(v===PW){localStorage.setItem(SK,'1');document.getElementById('ao').style.display='none';document.getElementById('mc').style.display='block';}else{document.getElementById('ae').style.display='block';}}
if(localStorage.getItem(SK)==='1'){document.getElementById('ao').style.display='none';document.getElementById('mc').style.display='block';}
function toggleCard(c){c.classList.toggle('open');}
function toggleSection(h){h.classList.toggle('collapsed');h.nextElementSibling.classList.toggle('hidden');}
const ranked=${JSON.stringify(ranked)};
function exportCSV(){
  const h=['Rank','Name','Score','Tier','Function & Level','Seniority','Player/Coach','Company Stage','GTM','Deal Size','Tech Fluency','Industry','Headline','Strengths','Gaps','Link'];
  const r=ranked.map((c,i)=>[i+1,c.name,c.score,c.tier,c.functionLevel??'',c.seniority??'',c.playerCoach??'',c.companyStage??'',c.gtm??'',c.dealSize??'',c.techFluency??'',c.industry??'','"'+(c.headline??'').replace(/"/g,'""')+'"','"'+(c.strengths??[]).join('; ').replace(/"/g,'""')+'"','"'+(c.gaps??[]).join('; ').replace(/"/g,'""')+'"',c.url??'']);
  const csv=[h,...r].map(x=>x.join(',')).join('\n');
  const b=new Blob([csv],{type:'text/csv'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='ranking.csv';a.click();URL.revokeObjectURL(u);
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
