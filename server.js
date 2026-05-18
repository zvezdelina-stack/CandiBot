import pkg from '@slack/bolt';
const { App } = pkg;
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import express from 'express';

// ── Env ───────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY        = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN          = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN          = process.env.SLACK_APP_TOKEN;
const SLACK_SIGNING_SECRET     = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY         = process.env.METAVIEW_API_KEY;
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
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

// ── Config ────────────────────────────────────────────────────────────────────
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

// ── Intent detection ──────────────────────────────────────────────────────────
const INTENTS = {
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
- company: company name if mentioned
- criteria: any search criteria mentioned
- jd: job description text if pasted (long text)

Current session context: ${JSON.stringify(session)}

Return format: {"intent": "find", "entities": {"criteria": "VP Sales with enterprise SaaS experience"}}`,
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

async function fetchCandidates(filters, maxPages = Infinity, reportId = REPORT_ID_FALLBACK) {
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

// ── Intent handlers ───────────────────────────────────────────────────────────

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
      { type: 'section', text: { type: 'mrkdwn', text: '*👤 Look up a candidate*\nGet a quick profile on anyone we\'ve screened.\n_"Pull up Kristie Chen"_ or _"Tell me about Sarah Lee"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*💬 Ask follow-up questions*\nDig into any candidate after looking them up.\n_"What was their comp?"_ or _"What\'s their availability?"_' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*🔎 Search deeper*\nExtend a find query further back in the database.\n_"Search deeper"_ after any find result' } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_For pipeline ranking against a JD or scorecard, use the *Scorecard Ranking* skill in Claude. Say "reset" to clear context and start fresh._' }] },
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

  switch (intent) {
    case INTENTS.DEEPER:
      await handleDeeper(say, userId, session);
      break;
    case INTENTS.FOLLOWUP:
      await handleFollowup(say, userId, text, session);
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
      if (session.awaitingName) {
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

expressApp.listen(PORT, () => console.log(`Express server on port ${PORT}`));

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await slackApp.start();
  console.log('CandiBot is running (Socket Mode)');
})();
