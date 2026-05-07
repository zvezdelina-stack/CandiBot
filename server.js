const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT                   = process.env.PORT || 3000;
const ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN        = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET   = process.env.SLACK_SIGNING_SECRET;
const METAVIEW_API_KEY       = process.env.METAVIEW_API_KEY;
const RANKING_PASSWORD       = process.env.RANKING_PASSWORD;
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUBLIC_URL             = process.env.PUBLIC_URL || 'https://candibot-production.up.railway.app';

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ── Config ────────────────────────────────────────────────────────────────────
const REPORT_ID = '61729db2-3946-11f1-b952-fb44be0b5cdb';
const RANKING_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const FIELD_IDS = [
  'default:candidate', 'default:start_time', 'default:interviewer',
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

// ── HTTP helper (Chrome extension proxy) ─────────────────────────────────────
function postJsonRaw(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } }); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── Redis helpers ─────────────────────────────────────────────────────────────
async function saveRanking(id, data) {
  await redis.set(`ranking:${id}`, JSON.stringify(data), { ex: RANKING_TTL_SECONDS });
}

async function getRanking(id) {
  const raw = await redis.get(`ranking:${id}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Core: streaming agentic loop with Claude+MCP ──────────────────────────────
async function fetchAndRankCandidates(jd) {
  const systemPrompt = `You are an expert executive recruiter at SwingSearch, a retained search firm for venture-backed tech startups.

Your job:
1. Read the job description or scorecard and identify the relevant primary function(s) from this exact list: Sales, Marketing, Product, Engineering, Operations, Customer Success, People / HR, Data / Analytics, General Management. Choose all that apply.

2. Use the search_conversations Metaview tool to fetch candidates from report ID "${REPORT_ID}" with:
   - fields: ${JSON.stringify(FIELD_IDS)}
   - filters: [{"field_id": "AI:b04c164c-49be-11f1-9b23-674021cd80ae", "operation": "is_one_of", "value": <your chosen function list>}]
   - limit: 50
   - offset: 0

3. CRITICAL - YOU MUST PAGINATE. After each response check the has_more field. If has_more is true, call search_conversations again with offset incremented by 50. Keep going until has_more is explicitly false. Do not stop early. Do not rank until you have fetched ALL pages.

4. Once all pages are fetched, rank every candidate by fit against the job description or scorecard.

5. Return ONLY a valid JSON object - no markdown, no commentary, no backticks.

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
      "note": "<one additional nuanced observation>",
      "functionLevel": "<value or null>",
      "seniority": "<value or null>",
      "playerCoach": "<value or null>",
      "leadershipScope": "<value or null>",
      "gtm": "<value or null>",
      "companyStage": "<value or null>",
      "crossFunctional": "<value or null>",
      "compContext": "<value or null>",
      "availability": "<value or null>",
      "dealSize": "<value or null>",
      "techFluency": "<value or null>",
      "industry": "<value or null>",
      "reasonForLooking": "<value or null>",
      "location": "<value or null>",
      "interviewer": "<value or null>",
      "date": "<value or null>",
      "url": "<conversation url or null>"
    }
  ]
}

Scoring: 80-100 Strong Fit, 50-79 Possible Fit, 0-49 Not a Fit. Be precise and opinionated.`;

  const mcpServers = [{ type: 'url', url: 'https://mcp.metaview.ai/mcp', name: 'metaview', authorization_token: METAVIEW_API_KEY }];
  const messages = [{ role: 'user', content: `JOB DESCRIPTION / SCORECARD:\n\n${jd}\n\nFetch all candidates and return the ranked JSON.` }];
  const MAX_ITERATIONS = 20;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`Agentic iteration ${iterations}`);

    const stream = await anthropic.beta.messages.stream(
      { model: 'claude-sonnet-4-6', max_tokens: 32000, system: systemPrompt, mcp_servers: mcpServers, messages },
      { headers: { 'anthropic-beta': 'mcp-client-2025-04-04' } }
    );

    const finalMessage = await stream.finalMessage();
    const stopReason = finalMessage.stop_reason;
    const responseContent = finalMessage.content;

    console.log(`stop_reason: ${stopReason}, content types: ${responseContent.map(b => b.type).join(', ')}`);
    messages.push({ role: 'assistant', content: responseContent });

    if (stopReason === 'end_turn') {
      const textBlocks = responseContent.filter(b => b.type === 'text');
      const text = textBlocks[textBlocks.length - 1]?.text ?? '';
      const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON in response. Raw: ${text.slice(0, 400)}`);
      return JSON.parse(match[0]);
    }

    if (stopReason === 'tool_use') {
      const regularBlocks = responseContent.filter(b => b.type === 'tool_use');
      if (regularBlocks.length > 0) throw new Error('Unexpected regular tool_use blocks.');
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${stopReason}`);
  }

  throw new Error(`Loop exceeded ${MAX_ITERATIONS} iterations.`);
}

// ── Hosted ranking page HTML ──────────────────────────────────────────────────
function buildRankingHTML(rankingData) {
  const { jdSnippet, createdAt, ranked } = rankingData;
  const strong   = ranked.filter(r => r.tier === 'Strong Fit');
  const possible = ranked.filter(r => r.tier === 'Possible Fit');
  const notFit   = ranked.filter(r => r.tier === 'Not a Fit');

  const tierColor = { 'Strong Fit': '#1B7A4A', 'Possible Fit': '#9B6C1A', 'Not a Fit': '#8B2635' };
  const tierBg    = { 'Strong Fit': 'rgba(27,122,74,0.08)', 'Possible Fit': 'rgba(200,150,30,0.08)', 'Not a Fit': 'rgba(200,69,108,0.06)' };
  const tierBorder = { 'Strong Fit': 'rgba(27,122,74,0.25)', 'Possible Fit': 'rgba(200,150,30,0.25)', 'Not a Fit': 'rgba(200,69,108,0.2)' };

  function cardHTML(r, rank) {
    const tc = tierColor[r.tier] ?? '#8B2635';
    const tb = tierBg[r.tier] ?? 'rgba(200,69,108,0.06)';
    const tbd = tierBorder[r.tier] ?? 'rgba(200,69,108,0.2)';
    const strengths = (r.strengths ?? []).map(s => `<div class="bullet green">+&nbsp;${s}</div>`).join('');
    const gaps = (r.gaps ?? []).length
      ? (r.gaps ?? []).map(g => `<div class="bullet rose">–&nbsp;${g}</div>`).join('')
      : '<div style="color:#B0BEC9;font-size:12px">None identified</div>';
    const details = [
      ['Seniority', r.seniority], ['Player/Coach', r.playerCoach], ['Leadership Scope', r.leadershipScope],
      ['Company Stage', r.companyStage], ['GTM Experience', r.gtm], ['Deal Size', r.dealSize],
      ['Comp Context', r.compContext], ['Availability', r.availability], ['Tech Fluency', r.techFluency],
      ['Industry', r.industry], ['Cross-Functional', r.crossFunctional], ['Reason for Looking', r.reasonForLooking],
    ].filter(([,v]) => v).map(([label, val]) => `
      <div>
        <div class="detail-label">${label}</div>
        <div class="detail-value">${val}</div>
      </div>`).join('');

    return `
    <div class="card" style="border-left-color:${tc}" onclick="toggleCard(this)">
      <div class="card-header">
        <div class="rank">#${rank}</div>
        <div class="score" style="color:${tc};background:${tb};border-color:${tbd}">${r.score}</div>
        <div class="card-main">
          <div class="name-row">
            ${r.url ? `<a href="${r.url}" target="_blank" onclick="event.stopPropagation()" class="name-link">${r.name}</a>` : `<span class="name">${r.name}</span>`}
            ${r.functionLevel ? `<span class="meta">${r.functionLevel}</span>` : ''}
            ${r.location ? `<span class="meta dim">· ${r.location}</span>` : ''}
          </div>
          <div class="headline">${r.headline}</div>
        </div>
        <div class="tier-pill" style="color:${tc};background:${tb};border-color:${tbd}">${r.tier}</div>
        <div class="chevron">▾</div>
      </div>
      <div class="card-detail">
        <div class="sg-grid">
          <div>
            <div class="section-label green-label">Strengths</div>
            ${strengths}
          </div>
          <div>
            <div class="section-label rose-label">Gaps</div>
            ${gaps}
          </div>
        </div>
        ${r.note ? `<div class="note-box"><div class="detail-label">Recruiter Note</div><div style="font-size:13px;color:#2C3E55;line-height:1.6">${r.note}</div></div>` : ''}
        <div class="detail-grid">${details}</div>
        <div class="card-footer">
          ${r.interviewer ? `<span>Interviewed by <b>${r.interviewer}</b></span>` : ''}
          ${r.date ? `<span>${r.date}</span>` : ''}
          ${r.url ? `<a href="${r.url}" target="_blank" class="mv-link">View in Metaview →</a>` : ''}
        </div>
      </div>
    </div>`;
  }

  function sectionHTML(tier, candidates, startRank) {
    if (!candidates.length) return '';
    const cards = candidates.map((r, i) => cardHTML(r, startRank + i)).join('');
    return `
    <div class="tier-section">
      <div class="tier-header" onclick="toggleSection(this)">
        <div class="tier-line" style="background:${tierBorder[tier]}"></div>
        <div class="tier-title" style="color:${tierColor[tier]}">${tier}</div>
        <div class="tier-count">(${candidates.length})</div>
        <div class="tier-flex"></div>
        <div class="tier-chevron">▾</div>
      </div>
      <div class="tier-body">${cards}</div>
    </div>`;
  }

  const csvData = JSON.stringify(ranked.map((r, i) => ({
    rank: i+1, name: r.name, score: r.score, tier: r.tier,
    functionLevel: r.functionLevel, location: r.location, seniority: r.seniority,
    playerCoach: r.playerCoach, companyStage: r.companyStage, gtm: r.gtm,
    availability: r.availability, compContext: r.compContext, dealSize: r.dealSize,
    techFluency: r.techFluency, industry: r.industry, reasonForLooking: r.reasonForLooking,
    headline: r.headline,
    strengths: (r.strengths ?? []).join('; '),
    gaps: (r.gaps ?? []).join('; '),
    url: r.url,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Candidate Ranking — SwingSearch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Lato:wght@300;400;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Lato',sans-serif;background:#F7F9FC;color:#1B2B4B;min-height:100vh}
  a{color:inherit;text-decoration:none}

  /* Auth overlay */
  #auth-overlay{position:fixed;inset:0;background:#1B2B4B;display:flex;align-items:center;justify-content:center;z-index:100}
  .auth-box{background:#fff;border-radius:12px;padding:40px;width:360px;text-align:center}
  .auth-logo{font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:#1B2B4B;margin-bottom:4px}
  .auth-sub{font-size:12px;color:#8899AA;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:28px}
  .auth-input{width:100%;border:1px solid #DDE4EE;border-radius:6px;padding:10px 14px;font-size:14px;font-family:'Lato',sans-serif;color:#1B2B4B;margin-bottom:12px}
  .auth-input:focus{outline:none;border-color:#C8456C}
  .auth-btn{width:100%;background:#C8456C;color:#fff;border:none;border-radius:6px;padding:11px;font-size:13px;font-family:'Lato',sans-serif;font-weight:700;cursor:pointer;letter-spacing:0.05em}
  .auth-error{font-size:12px;color:#C8456C;margin-top:8px;display:none}

  /* Header */
  .header{background:#1B2B4B;padding:18px 40px;display:flex;align-items:center;justify-content:space-between}
  .header-left{display:flex;align-items:baseline;gap:14px}
  .brand{font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:#fff}
  .sep{color:rgba(255,255,255,0.3);font-size:14px}
  .page-title{font-size:12px;color:rgba(255,255,255,0.5);letter-spacing:0.1em;text-transform:uppercase}
  .export-btn{background:transparent;border:1px solid rgba(200,69,108,0.6);color:#C8456C;border-radius:6px;padding:7px 16px;font-size:12px;font-family:'Lato',sans-serif;cursor:pointer;font-weight:700;letter-spacing:0.05em}

  /* Main */
  .main{max-width:880px;margin:0 auto;padding:40px 24px 80px}

  /* Summary */
  .summary{padding-bottom:24px;border-bottom:1px solid #E8EDF3;margin-bottom:32px}
  .summary-eyebrow{font-size:11px;color:#8899AA;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px}
  .summary-title{font-family:'Playfair Display',serif;font-size:18px;color:#1B2B4B;font-weight:600;margin-bottom:16px}
  .summary-stats{display:flex;gap:28px}
  .stat-num{font-family:'Playfair Display',serif;font-size:26px;font-weight:700}
  .stat-label{font-size:11px;color:#8899AA;text-transform:uppercase;letter-spacing:0.08em;margin-top:2px}

  /* Tier section */
  .tier-section{margin-bottom:32px}
  .tier-header{display:flex;align-items:center;gap:12px;margin-bottom:12px;cursor:pointer;user-select:none}
  .tier-line{height:1px;width:24px;flex-shrink:0}
  .tier-title{font-family:'Playfair Display',serif;font-size:16px;font-weight:600}
  .tier-count{font-size:12px;color:#B0BEC9}
  .tier-flex{flex:1;height:1px;background:#F0F4F8}
  .tier-chevron{font-size:11px;color:#B0BEC9;transition:transform 0.2s}
  .tier-header.collapsed .tier-chevron{transform:rotate(-90deg)}
  .tier-body.hidden{display:none}

  /* Card */
  .card{background:#fff;border:1px solid #E8EDF3;border-left:3px solid #ccc;border-radius:8px;margin-bottom:8px;overflow:hidden;transition:box-shadow 0.2s,border-color 0.2s;cursor:pointer}
  .card:hover{box-shadow:0 4px 16px rgba(27,43,75,0.08)}
  .card.open{box-shadow:0 4px 20px rgba(27,43,75,0.1)}
  .card-header{padding:14px 18px;display:flex;align-items:center;gap:14px}
  .rank{font-size:11px;color:#B0BEC9;width:22px;text-align:right;flex-shrink:0}
  .score{border-radius:6px;border:1px solid;padding:3px 10px;font-size:14px;font-weight:700;flex-shrink:0;min-width:40px;text-align:center}
  .card-main{flex:1;min-width:0}
  .name-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .name-link{font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:#1B2B4B;border-bottom:1px solid #C8456C}
  .name{font-family:'Playfair Display',serif;font-size:15px;font-weight:600;color:#1B2B4B}
  .meta{font-size:11px;color:#8899AA}
  .meta.dim{color:#B0BEC9}
  .headline{font-size:12px;color:#677A8E;margin-top:3px;line-height:1.5}
  .tier-pill{border-radius:20px;border:1px solid;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;flex-shrink:0}
  .chevron{color:#B0BEC9;font-size:12px;transition:transform 0.2s;flex-shrink:0}
  .card.open .chevron{transform:rotate(180deg)}

  /* Card detail */
  .card-detail{display:none;padding:0 18px 18px 54px;border-top:1px solid #F0F4F8}
  .card.open .card-detail{display:block}
  .sg-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;margin-bottom:16px}
  .section-label{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;margin-bottom:8px}
  .green-label{color:#1B7A4A}
  .rose-label{color:#C8456C}
  .bullet{font-size:12px;color:#2C3E55;margin-bottom:6px;padding-left:14px;position:relative;line-height:1.55}
  .bullet.green::before{content:'+';position:absolute;left:0;color:#1B7A4A;font-weight:700}
  .bullet.rose::before{content:'–';position:absolute;left:0;color:#C8456C;font-weight:700}
  .note-box{background:rgba(27,43,75,0.04);border:1px solid rgba(27,43,75,0.08);border-radius:6px;padding:10px 14px;margin-bottom:16px}
  .detail-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 24px}
  .detail-label{font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8899AA;font-weight:700;margin-bottom:3px}
  .detail-value{font-size:13px;color:#2C3E55;line-height:1.5}
  .card-footer{margin-top:14px;display:flex;gap:20px;flex-wrap:wrap;border-top:1px solid #F0F4F8;padding-top:12px;font-size:11px;color:#B0BEC9;align-items:center}
  .card-footer b{color:#677A8E;font-weight:400}
  .mv-link{color:#C8456C;margin-left:auto;font-size:11px}

  @media(max-width:600px){
    .header{padding:14px 16px}
    .main{padding:24px 16px 60px}
    .sg-grid,.detail-grid{grid-template-columns:1fr}
    .card-header{flex-wrap:wrap}
    .tier-pill{display:none}
    .summary-stats{gap:16px}
  }
</style>
</head>
<body>

<!-- Auth overlay -->
<div id="auth-overlay">
  <div class="auth-box">
    <div class="auth-logo">SwingSearch</div>
    <div class="auth-sub">Candidate Ranking</div>
    <input id="pw-input" type="password" placeholder="Team password" class="auth-input" onkeydown="if(event.key==='Enter')checkAuth()">
    <button class="auth-btn" onclick="checkAuth()">View Rankings</button>
    <div id="auth-error" class="auth-error">Incorrect password</div>
  </div>
</div>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <span class="brand">SwingSearch</span>
    <span class="sep">/</span>
    <span class="page-title">Candidate Ranking</span>
  </div>
  <button class="export-btn" onclick="exportCSV()">Export CSV</button>
</div>

<!-- Main -->
<div class="main" id="main-content" style="display:none">
  <div class="summary">
    <div class="summary-eyebrow">Ranked against</div>
    <div class="summary-title">${jdSnippet}</div>
    <div style="font-size:11px;color:#B0BEC9;font-family:'Lato',sans-serif;margin-bottom:14px">Generated ${new Date(createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · Expires in 30 days</div>
    <div class="summary-stats">
      <div><div class="stat-num" style="color:#1B2B4B">${ranked.length}</div><div class="stat-label">Total</div></div>
      <div><div class="stat-num" style="color:#1B7A4A">${strong.length}</div><div class="stat-label">Strong Fit</div></div>
      <div><div class="stat-num" style="color:#9B6C1A">${possible.length}</div><div class="stat-label">Possible Fit</div></div>
      <div><div class="stat-num" style="color:#8B2635">${notFit.length}</div><div class="stat-label">Not a Fit</div></div>
    </div>
  </div>

  ${sectionHTML('Strong Fit', strong, 1)}
  ${sectionHTML('Possible Fit', possible, strong.length + 1)}
  ${sectionHTML('Not a Fit', notFit, strong.length + possible.length + 1)}
</div>

<script>
  const CORRECT_PW = ${JSON.stringify(RANKING_PASSWORD)};
  const STORAGE_KEY = 'ss_ranking_auth';

  function checkAuth() {
    const val = document.getElementById('pw-input').value;
    if (val === CORRECT_PW) {
      localStorage.setItem(STORAGE_KEY, '1');
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('main-content').style.display = 'block';
    } else {
      document.getElementById('auth-error').style.display = 'block';
    }
  }

  // Auto-auth if previously authenticated
  if (localStorage.getItem(STORAGE_KEY) === '1') {
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';
  }

  function toggleCard(card) {
    card.classList.toggle('open');
  }

  function toggleSection(header) {
    header.classList.toggle('collapsed');
    const body = header.nextElementSibling;
    body.classList.toggle('hidden');
  }

  // CSV export
  const ranked = ${JSON.stringify(ranked)};
  function exportCSV() {
    const headers = ['Rank','Name','Score','Tier','Function & Level','Location','Seniority','Player/Coach','Company Stage','GTM','Availability','Comp Context','Deal Size','Tech Fluency','Industry','Reason for Looking','Headline','Strengths','Gaps','Metaview Link'];
    const rows = ranked.map((r, i) => [
      i+1, r.name, r.score, r.tier,
      r.functionLevel??'', r.location??'', r.seniority??'',
      r.playerCoach??'', r.companyStage??'', r.gtm??'',
      r.availability??'', r.compContext??'', r.dealSize??'',
      r.techFluency??'', r.industry??'', r.reasonForLooking??'',
      '"'+(r.headline??'').replace(/"/g,'""')+'"',
      '"'+(r.strengths??[]).join('; ').replace(/"/g,'""')+'"',
      '"'+(r.gaps??[]).join('; ').replace(/"/g,'""')+'"',
      r.url??''
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'candidate-ranking.csv'; a.click();
    URL.revokeObjectURL(url);
  }
</script>
</body>
</html>`;
}

// ── Slack Bolt ────────────────────────────────────────────────────────────────
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET, endpoints: '/slack/events' });
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
          type: 'input', block_id: 'jd_block',
          label: { type: 'plain_text', text: 'Job Description or Scorecard' },
          element: { type: 'plain_text_input', action_id: 'jd_input', multiline: true, placeholder: { type: 'plain_text', text: 'Paste the job description, scorecard, or key criteria here…' } },
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
      const holding = await client.chat.postMessage({ channel: target, text: '⏳ Fetching candidates and running ranking… this usually takes 1–2 minutes. I\'ll post the link when it\'s ready.' });
      holdingTs = holding.ts;
    } catch (e) { console.error('Holding message failed:', e.message); }

    try {
      const result = await fetchAndRankCandidates(jd);
      const ranked = result.ranked.sort((a, b) => b.score - a.score);

      // Save to Redis
      const id = crypto.randomBytes(8).toString('hex');
      const jdSnippet = jd.length > 100 ? jd.slice(0, 100) + '…' : jd;
      await saveRanking(id, { jdSnippet, createdAt: new Date().toISOString(), ranked });

      const url = `${PUBLIC_URL}/ranking/${id}`;
      const strong   = ranked.filter(r => r.tier === 'Strong Fit').length;
      const possible = ranked.filter(r => r.tier === 'Possible Fit').length;

      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '✅ Candidate Ranking Ready', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${ranked.length} candidates ranked* against:\n_${jdSnippet}_` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*🟢 Strong Fit*\n${strong} candidates` },
          { type: 'mrkdwn', text: `*🟡 Possible Fit*\n${possible} candidates` },
        ]},
        { type: 'section', text: { type: 'mrkdwn', text: `*<${url}|View Full Ranking →>*\n_Link expires in 30 days · Team password required_` } },
      ];

      if (holdingTs) {
        await client.chat.update({ channel: target, ts: holdingTs, text: `Ranking complete. View at ${url}`, blocks });
      } else {
        await client.chat.postMessage({ channel: target, text: `Ranking complete. View at ${url}`, blocks });
      }
    } catch (err) {
      console.error('Ranking error:', err);
      const errMsg = `❌ Ranking failed: ${err.message ?? 'Unknown error'}`;
      if (holdingTs) { await client.chat.update({ channel: target, ts: holdingTs, text: errMsg }); }
      else { await client.chat.postMessage({ channel: target, text: errMsg }); }
    }
  });
});

// ── Express routes ────────────────────────────────────────────────────────────
const expressApp = receiver.app;
expressApp.use(express.json());

// Hosted ranking page
expressApp.get('/ranking/:id', async (req, res) => {
  try {
    const data = await getRanking(req.params.id);
    if (!data) return res.status(404).send('<h2>Ranking not found or expired.</h2>');
    res.set('Content-Type', 'text/html').send(buildRankingHTML(data));
  } catch (e) {
    console.error('Ranking fetch error:', e);
    res.status(500).send('<h2>Error loading ranking.</h2>');
  }
});

// Chrome extension proxy
expressApp.post('/company-info', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const data = JSON.stringify(req.body);
  const apiReq = https.request(
    { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } },
    (apiRes) => { let buf = ''; apiRes.on('data', c => buf += c); apiRes.on('end', () => res.status(apiRes.statusCode).set('Content-Type', 'application/json').send(buf)); }
  );
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(data); apiReq.end();
});

// DNP list
expressApp.get('/dnp-list', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try { res.set('Content-Type', 'text/plain').send(fs.readFileSync(path.join(__dirname, 'dnp.csv'), 'utf8')); }
  catch (e) { res.status(500).json({ error: 'Could not read DNP list' }); }
});

// CORS preflight
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
