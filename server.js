const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.JIRA_CLIENT_ID;
const CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET;
const REDIRECT_URI = 'https://weekly-pulse.onrender.com/callback';

app.get('/test', (req, res) => res.json({ clientId: CLIENT_ID, hasSecret: !!CLIENT_SECRET }));

app.get('/auth', (req, res) => {
  const authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${CLIENT_ID}&scope=read%3Ajira-work%20read%3Ajira-user%20read%3Asprint%3Ajira-software&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&prompt=consent`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    res.redirect(`https://weekly-pulse-report.netlify.app/#token=${accessToken}`);
  } catch (err) {
    res.status(500).json({ error: 'OAuth failed', details: err.message });
  }
});

app.get('/jira/issues', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const sitesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const sites = await sitesRes.json();
    const cloudId = sites[0].id;

    const issuesRes = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search?jql=ORDER%20BY%20updated%20DESC&maxResults=50&fields=summary,status,assignee,description,priority`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );

    const issuesData = await issuesRes.json();
    const issues = issuesData.issues || [];

    const done = issues.filter(i => i.fields.status.name.toLowerCase() === 'done');
    const inProgress = issues.filter(i => i.fields.status.name.toLowerCase() === 'in progress');
    const toDo = issues.filter(i => i.fields.status.name.toLowerCase() === 'to do');
    const blocked = issues.filter(i => {
      const desc = i.fields.description?.content?.[0]?.content?.[0]?.text || '';
      return desc.toLowerCase().includes('blocked');
    });

    res.json({
      done: done.map(i => i.fields.summary),
      inProgress: inProgress.map(i => i.fields.summary),
      toDo: toDo.map(i => i.fields.summary),
      blocked: blocked.map(i => i.fields.summary),
      total: issues.length
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch issues', details: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'Weekly Pulse backend running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
