const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────
const CLIENT_ID = process.env.JIRA_CLIENT_ID;
const CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET;
const CALLBACK_URL = 'https://weekly-pulse.onrender.com/callback';
const FRONTEND_URL = 'https://weekly-pulse-report.netlify.app';

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

    // FIX: sprint data lives in customfield_10020, not 'sprint'
    const fields = 'summary,status,description,assignee,priority,created,updated,customfield_10020';
    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=50&fields=${fields}`;

    console.log('JQL:', jql);

    const issuesRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const issuesData = await issuesRes.json();
    console.log('Total issues found:', issuesData.total);

    // FIX: Catch Jira error responses before they get swallowed
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

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Weekly Pulse backend running on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Callback: ${CALLBACK_URL}`);
});
