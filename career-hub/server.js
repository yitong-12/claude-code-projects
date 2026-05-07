'use strict';
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── System prompts (prompt-cached) ──────────────────────────────────────────

const HR_SYSTEM = `You are a Head of Human Resources with 10 years of experience at top-tier firms — Goldman Sachs, McKinsey, and Google. You have reviewed over 10,000 resumes and have an extremely sharp eye for talent. You know exactly what a "must-hire" looks like, and you are not here to be encouraging — you are here to give the hiring manager a clear, expert verdict.

Format your response in clean markdown using these exact sections:

## 🎯 VERDICT
**[MUST-HIRE / STRONG CANDIDATE / BORDERLINE / NOT A FIT]** — Confidence: X%
One direct sentence justifying this verdict.

## 💪 STRENGTHS
What genuinely stands out. Be specific — cite actual lines and bullet points from the resume. Not generic praise.

## 🚫 CRITICAL GAPS
Concrete mismatches between this resume and the job requirements. Be direct. No softening.

## 📋 IMPROVEMENT PLAN
Ranked list of specific, actionable changes that would move this candidate toward must-hire. Prioritize by impact.

## 🎤 INTERVIEW COACHING
The 2–3 things this candidate absolutely must prepare to address if they get the interview.`;

const REDLINE_SYSTEM = `You are a top-tier executive resume writer and former Head of HR with 10 years of experience. You have transformed hundreds of mediocre resumes into must-hire documents.

Your job: Rewrite this resume so it becomes a must-hire for the specific role described. Never fabricate credentials. But aggressively reframe real experience using the exact language, keywords, and framing of the job description. Every bullet point should scream "this person was made for this role."

Format your response in clean markdown:

## ✏️ REWRITTEN RESUME

The complete rewritten resume. For every significant change, show it like this:
~~original line~~ → **new line** *(why this change)*

Unchanged lines appear normally without annotation.

## 📝 KEY CHANGES
Bulleted summary of the major strategic changes and the reasoning behind them.

## ⚠️ REMAINING GAPS
What couldn't be fixed in the resume itself. How to address these in the cover letter and interview.

## 🔑 KEYWORDS WOVEN IN
The critical terms from the JD that you incorporated and where.`;

const STARTUP_SYSTEM = `You are a Senior Partner at Sequoia Capital with 20 years of venture capital experience. You have led investments in Stripe, Airbnb, DoorDash, Nubank, and dozens of others. You evaluate over 500 startups per year and have an extraordinary ability to separate fundable companies from noise.

You are brutally honest. You have zero patience for vague market claims, weak competitive moats, or teams that don't understand their own business. You ask the questions that founders avoid. Your job is not to encourage — it is to give a clear-eyed, thorough analysis.`;

// ── SSE streaming helper ─────────────────────────────────────────────────────

async function streamToSSE(res, messages, systemText, maxTokens, useThinking = false) {
  const params = {
    model: 'claude-opus-4-7',
    max_tokens: maxTokens,
    stream: true,
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (useThinking) {
    params.thinking = { type: 'adaptive' };
  }

  const stream = await client.messages.create(params);
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

// ── Resume Review ────────────────────────────────────────────────────────────

app.post('/api/review', upload.single('resume'), async (req, res) => {
  const { jobDescription } = req.body;
  if (!req.file || !jobDescription?.trim()) {
    return res.status(400).json({ error: 'Resume file and job description are required.' });
  }
  startSSE(res);
  try {
    const pdf = await pdfParse(req.file.buffer);
    const resumeText = pdf.text?.trim()?.substring(0, 9000) || '';
    if (resumeText.length < 50) {
      res.write(`data: ${JSON.stringify({ error: 'Could not extract text from PDF. Make sure it is a text-based (not scanned) PDF.' })}\n\n`);
      return res.end();
    }
    await streamToSSE(res, [{
      role: 'user',
      content: `**JOB DESCRIPTION:**\n\n${jobDescription.substring(0, 4000)}\n\n---\n\n**CANDIDATE RESUME:**\n\n${resumeText}`
    }], HR_SYSTEM, 2500, true);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Resume Redline ───────────────────────────────────────────────────────────

app.post('/api/redline', upload.single('resume'), async (req, res) => {
  const { jobDescription } = req.body;
  if (!req.file || !jobDescription?.trim()) {
    return res.status(400).json({ error: 'Resume file and job description are required.' });
  }
  startSSE(res);
  try {
    const pdf = await pdfParse(req.file.buffer);
    const resumeText = pdf.text?.trim()?.substring(0, 9000) || '';
    if (resumeText.length < 50) {
      res.write(`data: ${JSON.stringify({ error: 'Could not extract text from PDF. Make sure it is a text-based (not scanned) PDF.' })}\n\n`);
      return res.end();
    }
    await streamToSSE(res, [{
      role: 'user',
      content: `**JOB DESCRIPTION:**\n\n${jobDescription.substring(0, 4000)}\n\n---\n\n**ORIGINAL RESUME:**\n\n${resumeText}`
    }], REDLINE_SYSTEM, 4500, true);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Job Finder ───────────────────────────────────────────────────────────────

const JOB_SEARCHES = {
  finance: [
    { label: 'Financial Analyst', kw: 'financial+analyst' },
    { label: 'Investment Banking Analyst', kw: 'investment+banking+analyst' },
    { label: 'Investment Analyst', kw: 'investment+analyst' },
    { label: 'Family Office Analyst', kw: 'family+office+analyst' },
    { label: 'Junior Equity Research', kw: 'equity+research+analyst+junior' },
    { label: 'Private Equity Analyst', kw: 'private+equity+analyst+entry+level' },
  ],
  operations: [
    { label: 'Business Operations (Startup)', kw: 'business+operations+startup' },
    { label: 'Product Operations', kw: 'product+operations' },
    { label: 'Strategy & Operations', kw: 'strategy+and+operations' },
    { label: 'Biz Ops', kw: 'biz+ops+associate' },
    { label: 'Associate Product Manager', kw: 'associate+product+manager' },
    { label: 'Startup Operations', kw: 'operations+manager+startup+early+stage' },
  ],
  consulting: [
    { label: 'Management Consulting Analyst', kw: 'management+consulting+analyst' },
    { label: 'Associate Consultant', kw: 'associate+consultant' },
    { label: 'Strategy Consultant', kw: 'strategy+consultant+entry+level' },
    { label: 'Business Analyst (Consulting Firm)', kw: 'business+analyst+consulting+firm' },
    { label: 'Operations Consultant', kw: 'operations+consultant' },
  ],
  rotational: [
    { label: 'Startup Rotational Program', kw: 'rotational+program+startup+entry+level' },
    { label: 'New Grad Associate Program', kw: 'new+graduate+associate+program+tech' },
    { label: 'Early Career Rotational', kw: 'early+career+rotational+program' },
    { label: 'Generalist Rotation (Startup)', kw: 'generalist+rotation+startup' },
    { label: 'BizOps Rotation / New Grad', kw: 'business+operations+rotation+new+grad' },
    { label: 'Venture-Backed New Grad', kw: 'new+grad+operations+venture+backed+startup' },
  ]
};

app.get('/api/jobs', async (req, res) => {
  const { category = 'finance' } = req.query;
  const searches = JOB_SEARCHES[category] || JOB_SEARCHES.finance;

  const linkedinLinks = searches.map(s => ({
    label: s.label,
    linkedin: `https://www.linkedin.com/jobs/search/?keywords=${s.kw}&f_TPR=r604800&sortBy=DD`,
    indeed: `https://www.indeed.com/jobs?q=${s.kw}&sort=date&fromage=7`,
  }));

  // Best-effort Indeed RSS (may be blocked)
  const liveJobs = [];
  for (const s of searches.slice(0, 3)) {
    try {
      const resp = await fetch(
        `https://www.indeed.com/rss?q=${s.kw}&sort=date&fromage=7&limit=4`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(4000)
        }
      );
      if (!resp.ok) continue;
      const xml = await resp.text();
      for (const [, item] of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3)) {
        const title = (/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/.exec(item) || [])[1]?.trim() || '';
        const link  = (/<link>(.*?)<\/link>/.exec(item) || [])[1]?.trim() || '';
        const date  = (/<pubDate>(.*?)<\/pubDate>/.exec(item) || [])[1]?.trim() || '';
        if (title && link) liveJobs.push({ title, link, date, category: s.label });
      }
    } catch { /* blocked or timed out */ }
  }

  res.json({ linkedinLinks, liveJobs });
});

// ── Startup Analysis ─────────────────────────────────────────────────────────

app.post('/api/startup', async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL is required.' });
  startSSE(res);

  let pageContent = '';
  try {
    const pageResp = await fetch(url.trim(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(9000)
    });
    const html = await pageResp.text();
    pageContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 7000);
  } catch {
    pageContent = '[Website could not be fetched — analyze based on URL and any publicly known information about this company]';
  }

  try {
    await streamToSSE(res, [{
      role: 'user',
      content: `Analyze this startup the way a Sequoia senior partner would in a first meeting. Be specific, thorough, and brutally honest.

Website: ${url}

Website content extracted:
${pageContent}

---

Structure your analysis exactly as follows:

## 🎯 ONE-LINE VERDICT
Would Sequoia take a meeting? **YES / MAYBE / NO** — one sentence explanation.

## 📊 SCORECARD
Rate each dimension 1–10 with a one-line justification:
- **Market (TAM/SAM/SOM):** X/10
- **Team/Founders (inferred from site):** X/10
- **Product / Technology:** X/10
- **Business Model:** X/10
- **Traction / Growth Signals:** X/10
- **Competitive Moat:** X/10
- **Timing:** X/10
- **OVERALL:** X/10

## 💪 WHAT'S COMPELLING
The 3–4 things that are genuinely strong about this company. Specific, not generic.

## ⚠️ RED FLAGS & WEAKNESSES
What would make Sequoia pass on this. Be direct. Founders need to hear this.

## ❓ THE FIRST-MEETING QUESTIONS
The 5 exact questions a Sequoia partner would ask in the first 15 minutes.

## 🔮 MARKET ANALYSIS
- **Real TAM** (with reasoning — not just "trillion dollar market")
- **Key competitors** (named, with differentiation assessment)
- **The defensible wedge** — what actually protects them?

## 💡 SEQUOIA'S THESIS
What would need to be true to write a check? What stage fits? What would the investment thesis look like in one paragraph?`
    }], STARTUP_SYSTEM, 3500, true);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Career Hub → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️   ANTHROPIC_API_KEY not set — copy .env.example to .env and add your key');
  }
});
