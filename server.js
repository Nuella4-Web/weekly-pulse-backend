const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────
const CLIENT_ID = process.env.JIRA_CLIENT_ID;
const CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET;
const CALLBACK_URL = 'https://weekly-pulse.onrender.com/callback';
const FRONTEND_URL = 'https://project-radar.netlify.app';

// ─── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Weekly Pulse backend is running' });
});

// ─── OAuth: Step 1 — Redirect user to Atlassian ──────────
app.get('/auth', (req, res) => {
  const scopes = [
    'read:jira-work',
    'read:jira-user',
    'read:issue:jira',
    'read:project:jira',
    'read:issue-details:jira',
    'read:jql:jira',
    'read:sprint:jira-software',
    'read:board-scope:jira-software',
    'read:user:jira',
    'offline_access'
  ].join(' ');

  const authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&response_type=code&prompt=consent`;

  console.log('Redirecting to Atlassian OAuth...');
  res.redirect(authUrl);
});

// ─── OAuth: Step 2 — Exchange code for token ──────────────
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    console.error('No auth code received');
    return res.redirect(`${FRONTEND_URL}#error=no_code`);
  }

  try {
    console.log('Exchanging auth code for token...');

    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        redirect_uri: CALLBACK_URL
      })
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('Token error:', tokenData);
      return res.redirect(`${FRONTEND_URL}#error=${tokenData.error}`);
    }

    console.log('Token obtained successfully');
    console.log('Scopes granted:', tokenData.scope);

    // ── Dynamically resolve the Cloud ID from the token ──
    let cloudId = null;
    try {
      const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/json'
        }
      });
      const resources = await resourcesRes.json();
      if (Array.isArray(resources) && resources.length > 0) {
        cloudId = resources[0].id;
        console.log('Resolved Cloud ID:', cloudId, '— Site:', resources[0].name);
      }
    } catch (e) {
      console.error('Failed to resolve Cloud ID:', e.message);
    }

    const params = new URLSearchParams({
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer'
    });

    if (tokenData.refresh_token) params.append('refresh_token', tokenData.refresh_token);
    if (cloudId) params.append('cloud_id', cloudId);

    res.redirect(`${FRONTEND_URL}#${params.toString()}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}#error=token_exchange_failed`);
  }
});

// ─── Helper: Extract Bearer token from request ────────────
function getToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.split(' ')[1];
}

// ─── Helper: Get Cloud ID from query param or header ──────
function getCloudId(req) {
  return req.query.cloud_id || req.headers['x-cloud-id'] || null;
}

// ─── Jira: Fetch issues (main endpoint) ───────────────────
app.get('/jira/issues', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const cloudId = getCloudId(req);
  if (!cloudId) return res.status(400).json({ error: 'No cloud_id provided. Pass it as a query param: /jira/issues?cloud_id=YOUR_CLOUD_ID' });

  try {
    console.log('Fetching Jira issues for cloud:', cloudId);

    // ── Step 1: Dynamically fetch the first available project key ──
    let projectKey = null;
    const projectsRes = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
    );
    const projects = await projectsRes.json();

    if (Array.isArray(projects) && projects.length > 0) {
      projectKey = projects[0].key;
      console.log(`Using project key: ${projectKey} (${projects[0].name})`);
    } else {
      console.warn('No projects found — falling back to unfiltered JQL');
    }

    // ── Step 2: Build JQL scoped to project if found ──
    const jql = projectKey
      ? `project = ${projectKey} ORDER BY updated DESC`
      : 'ORDER BY updated DESC';

    // GET /rest/api/3/search/jql — the correct replacement for deprecated api/2/search
    const fields = 'summary,status,description,assignee,priority,created,updated,customfield_10020';
    const searchUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`;

    console.log('JQL:', jql);

    const issuesRes = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const issuesData = await issuesRes.json();
    console.log('HTTP status:', issuesRes.status);
    console.log('Raw Jira response:', JSON.stringify(issuesData).substring(0, 800));
    console.log('Total issues found:', issuesData.total);

    // Catch Jira error responses before they get swallowed
    if (issuesData.errorMessages?.length || Object.keys(issuesData.errors || {}).length) {
      console.error('Jira API returned an error:', JSON.stringify(issuesData));
      return res.status(400).json({ error: 'Jira API error', details: issuesData });
    }

    res.json(categorizeIssues(issuesData));
  } catch (err) {
    console.error('Error fetching issues:', err);
    res.status(500).json({ error: 'Failed to fetch issues', details: err.message });
  }
});

// ─── Helper: Categorize issues by status ──────────────────
function categorizeIssues(issuesData) {
  const toDo = [];
  const inProgress = [];
  const done = [];
  const blocked = [];

  if (issuesData.issues && issuesData.issues.length > 0) {
    issuesData.issues.forEach(issue => {
      const statusName = issue.fields.status?.name?.toLowerCase() || '';
      const statusCategory = issue.fields.status?.statusCategory?.key?.toLowerCase() || '';

      const item = {
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name,
        statusCategory: issue.fields.status?.statusCategory?.name,
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        priority: issue.fields.priority?.name || 'None',
        description: issue.fields.description,
        created: issue.fields.created,
        updated: issue.fields.updated,
        // FIX: correctly mapped from customfield_10020
        sprint: issue.fields.customfield_10020 || null
      };

      if (statusName.includes('block')) {
        blocked.push(item);
      } else if (statusCategory === 'done' || statusName === 'done') {
        done.push(item);
      } else if (statusCategory === 'indeterminate' || statusName === 'in progress' || statusName.includes('progress')) {
        inProgress.push(item);
      } else {
        toDo.push(item);
      }
    });
  }

  const STALE_DAYS = 5;
  const now = new Date();

  function daysSince(dateStr) {
    return Math.floor((now - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  }

  // Flag stalled tickets across all active buckets
  const allActive = [...toDo, ...inProgress, ...blocked];
  allActive.forEach(item => {
    item.daysSinceUpdate = daysSince(item.updated);
    item.stalled = item.daysSinceUpdate >= STALE_DAYS;
  });

  return {
    total: issuesData.total || 0,
    toDo,
    inProgress,
    done,
    blocked
  };
}

// ─── Debug: Check accessible resources ────────────────────
app.get('/debug-jira', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const resources = await resourcesRes.json();

    const meRes = await fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const me = await meRes.json();

    res.json({
      user: me,
      accessibleResources: resources,
      availableCloudIds: Array.isArray(resources) ? resources.map(r => ({ id: r.id, name: r.name })) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: List all projects visible to token ────────────
app.get('/debug-projects', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const cloudId = getCloudId(req);
  if (!cloudId) return res.status(400).json({ error: 'Pass cloud_id as query param' });

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const data = await response.json();
    res.json({ count: Array.isArray(data) ? data.length : 0, projects: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: Fetch a single issue by key ───────────────────
app.get('/debug-issue/:issueKey', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const cloudId = getCloudId(req);
  if (!cloudId) return res.status(400).json({ error: 'Pass cloud_id as query param' });

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${req.params.issueKey}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: Check what permissions the token actually has ──
app.get('/debug-permissions', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const cloudId = getCloudId(req);
  if (!cloudId) return res.status(400).json({ error: 'Pass cloud_id as query param' });

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,READ_PROJECT,VIEW_WORKFLOW_READONLY`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Generate Report via Claude API ──────────────────────

// Step 1: Pure deterministic health score — same input always = same score
function calculateHealthScore(done, blocked, risk, next) {
  let score = 85; // baseline

  // Count distinct completed items in progress field (positive signal)
  const doneText = done.trim();
  const doneSentences = doneText.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const progressPoints = Math.min(doneSentences.length * 3, 15);
  score += progressPoints;

  // Count distinct blockers (highest impact — negative)
  const blockerText = blocked.trim();
  const blockerSentences = blockerText.split(/[.!?]+/).filter(s => s.trim().length > 5);
  // Only deduct if actual blockers are mentioned, not "no blockers"
  const hasNoBlockers = blockerText.toLowerCase().includes('no blocker') ||
    blockerText.toLowerCase().includes('none') ||
    blockerText.toLowerCase().includes('no active');
  if (!hasNoBlockers) {
    const blockerDeduction = Math.min(blockerSentences.length * 12, 35);
    score -= blockerDeduction;
  }

  // Count distinct risks (medium impact — negative)
  const riskText = risk.trim();
  const riskSentences = riskText.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const hasNoRisks = riskText.toLowerCase().includes('no risk') ||
    riskText.toLowerCase().includes('none') ||
    riskText.toLowerCase().includes('no items');
  if (!hasNoRisks) {
    const riskDeduction = Math.min(riskSentences.length * 8, 25);
    score -= riskDeduction;
  }

  // Next priorities vagueness (low impact — negative)
  const nextText = next.trim();
  const nextSentences = nextText.split(/[.!?]+/).filter(s => s.trim().length > 5);
  if (nextSentences.length < 2) {
    score -= 10;
  }

  // Clamp between 10 and 98
  return Math.max(10, Math.min(98, score));
}

// Step 2: Derive urgency directly from score — fixed thresholds, never changes
function deriveUrgency(score) {
  if (score >= 76) return 'Stable';
  if (score >= 56) return 'Moderate';
  if (score >= 40) return 'High';
  return 'Critical';
}

app.post('/generate-report', async (req, res) => {
  const { done, blocked, risk, next } = req.body;

  if (!done || !blocked || !risk || !next) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Calculate score and urgency FIRST — these never change for same inputs
  const healthScore = calculateHealthScore(done, blocked, risk, next);
  const urgency = deriveUrgency(healthScore);

  console.log('Health score:', healthScore, '| Urgency:', urgency);

  // Step 3: Build prompt with score and urgency as fixed facts AI must write around
  const prompt = `You are a senior project manager writing a weekly status report.

FIXED FACTS — do not change these under any circumstances:
- Project Health Score: ${healthScore}
- Urgency Level: ${urgency}
- These are calculated from the actual project data and are not up for interpretation.

FORMATTING RULES — follow strictly:
- Never use dashes or em dashes. Use full stops or commas instead.
- Never use the arrow symbol. Write consequence as a new sentence starting with "This means" or "Without this" or "If unresolved".
- Write in plain, professional English. No jargon.

YOUR JOB:
Transform the raw inputs into four clean report sections. Each section must have:
1. A 2 to 3 sentence summary that adds context, not just rewords the input.
2. One consequence sentence starting with "This means" or "Without this" or "If unresolved".

Then write a VERDICT. One paragraph. Read across all four sections and identify the single biggest threat to this project right now and what must happen to address it. The verdict must be consistent with a project health of ${healthScore} and urgency of ${urgency}. If urgency is Critical, the verdict must reflect immediate crisis. If Stable, the verdict must reflect a positive outlook with minor watchpoints. Be direct. No dashes.

Then write one urgency reason sentence that explains why the project is at ${urgency} level.

Raw inputs:
PROGRESS MADE: ${done}
BLOCKERS: ${blocked}
RISKS & DELAYS: ${risk}
NEXT PRIORITIES: ${next}

Respond ONLY with valid JSON. No markdown, no extra text:
{
  "done": "summary. Consequence sentence.",
  "blocked": "summary. Consequence sentence.",
  "risk": "summary. Consequence sentence.",
  "next": "summary. Consequence sentence.",
  "verdict": "One paragraph consistent with ${urgency} urgency. No dashes.",
  "urgency": "${urgency}",
  "urgency_reason": "One sentence. No dashes."
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: 'Claude API error', details: data.error });
    }

    const rawText = data.content[0].text;
    console.log('Raw AI response:', rawText.substring(0, 300));

    const text = rawText.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw text:', rawText);
      return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });
    }

    // Always override with our deterministic values — AI cannot change these
    result.health = healthScore;
    result.urgency = urgency;

    // Strip any dashes from all text fields before sending to frontend
    function cleanDashes(text) {
      if (!text) return text;
      return text
        .replace(/\s*—\s*/g, '. ')   // em dash
        .replace(/\s*–\s*/g, ', ')   // en dash
        .replace(/\s*-{2,}\s*/g, '. ') // double hyphen
        .replace(/\.\s*\./g, '.')    // clean up double full stops
        .trim();
    }

    result.done = cleanDashes(result.done);
    result.blocked = cleanDashes(result.blocked);
    result.risk = cleanDashes(result.risk);
    result.next = cleanDashes(result.next);
    result.verdict = cleanDashes(result.verdict);
    result.urgency_reason = cleanDashes(result.urgency_reason);

    res.json(result);
  } catch (err) {
    console.error('Generate report error:', err.message);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
});


// ─── Contact form submission ───────────────────────────────
app.post('/contact', async (req, res) => {
  const { name, email, message, reportContext } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const emailBody = `
New lead from Project Radar

Name: ${name}
Email: ${email}

Message:
${message}

Report Context:
Health Score: ${reportContext?.health || 'N/A'}
Urgency: ${reportContext?.urgency || 'N/A'}

PM Verdict:
${reportContext?.verdict || 'N/A'}

---
Sent from project-radar.netlify.app
    `.trim();

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Project Radar <onboarding@resend.dev>',
        to: 'nuellachukwudi4@gmail.com',
        subject: 'New lead from Project Radar: ' + name,
        text: emailBody
      })
    });

    const emailData = await emailRes.json();

    if (emailData.id) {
      console.log('Contact email sent for:', name, email);
      res.json({ success: true });
    } else {
      console.error('Email send failed:', JSON.stringify(emailData));
      res.status(500).json({ error: 'Email failed to send' });
    }
  } catch (err) {
    console.error('Contact endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Weekly Pulse backend running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Callback: ${CALLBACK_URL}`);
});
