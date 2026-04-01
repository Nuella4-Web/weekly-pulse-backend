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
const CLOUD_ID = '85ac1498-4a4c-49a5-a04f-22069874b42a';

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
  // Both classic AND granular scopes needed:
  // Classic scopes = authorize the REST API v2 endpoints
  // Granular scopes = control data visibility
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

    // Redirect to frontend with token in URL hash
    const params = new URLSearchParams({
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer'
    });

    // Include refresh token if available (requires offline_access scope)
    if (tokenData.refresh_token) {
      params.append('refresh_token', tokenData.refresh_token);
    }

    res.redirect(`${FRONTEND_URL}#${params.toString()}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}#error=token_exchange_failed`);
  }
});

// ─── Helper: Extract Bearer token from request ────────────
function getToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.split(' ')[1];
}

// ─── Jira: Fetch issues (main endpoint) ───────────────────
app.get('/jira/issues', async (req, res) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    console.log('Fetching Jira issues...');

    // Fetch all issues from the project, sorted by update date
    const jql = encodeURIComponent('project = SCRUM ORDER BY updated DESC');
    const fields = 'summary,status,description,assignee,priority,created,updated,sprint';
    const url = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/2/search?jql=${jql}&maxResults=50&fields=${fields}`;

    console.log('Request URL:', url);

    const issuesRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const issuesData = await issuesRes.json();
    console.log('Total issues found:', issuesData.total);
    console.log('Raw response preview:', JSON.stringify(issuesData).substring(0, 500));

    // If zero issues, try a broader query as fallback
    if (issuesData.total === 0) {
      console.log('Zero issues with project filter. Trying broad query...');

      const fallbackUrl = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/2/search?jql=${encodeURIComponent('ORDER BY updated DESC')}&maxResults=50&fields=${fields}`;

      const fallbackRes = await fetch(fallbackUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });

      const fallbackData = await fallbackRes.json();
      console.log('Fallback total:', fallbackData.total);

      if (fallbackData.total > 0) {
        console.log('Fallback found issues — project key might be different');
        return res.json(categorizeIssues(fallbackData));
      }
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
        updated: issue.fields.updated
      };

      // Categorize based on status category (more reliable than status name)
      if (statusName.includes('block')) {
        blocked.push(item);
      } else if (statusCategory === 'done' || statusName === 'done') {
        done.push(item);
      } else if (statusCategory === 'indeterminate' || statusName === 'in progress' || statusName.includes('progress')) {
        inProgress.push(item);
      } else {
        // "new" category or anything else goes to To Do
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
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    // Check accessible resources
    const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
    const resources = await resourcesRes.json();

    // Check token scopes
    const scopeRes = await fetch('https://api.atlassian.com/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
    const me = await scopeRes.json();

    res.json({
      user: me,
      accessibleResources: resources,
      cloudIdUsed: CLOUD_ID,
      cloudIdMatch: resources.some(r => r.id === CLOUD_ID)
    });
  } catch (err) {
    console.error('Debug error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: List all projects visible to token ────────────
app.get('/debug-projects', async (req, res) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/2/project`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
    );
    const data = await response.json();

    console.log('Projects visible:', JSON.stringify(data).substring(0, 500));
    res.json({
      count: Array.isArray(data) ? data.length : 0,
      projects: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug: Fetch a single issue by key ───────────────────
app.get('/debug-issue/:issueKey', async (req, res) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/2/issue/${req.params.issueKey}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
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
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/2/mypermissions?permissions=BROWSE_PROJECTS,READ_PROJECT,VIEW_WORKFLOW_READONLY`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
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
  console.log(`Cloud ID: ${CLOUD_ID}`);
});
