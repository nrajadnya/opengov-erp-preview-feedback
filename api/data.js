// Vercel Serverless Function -- /api/data
// Reads and writes feedback data stored in data.json in this GitHub repo.
// Env vars required (set in Vercel project settings):
//   GITHUB_TOKEN  -- fine-grained PAT with Contents read+write on this repo
//   APP_PASSWORD -- the manage-feedback password (keeps it off the frontend)

const https = require('https');

const REPO_OWNER = 'nrajadnya';
const REPO_NAME  = 'opengov-erp-preview-feedback';
const FILE_PATH  = 'data.json';
const BRANCH     = 'main';

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'opengov-erp-feedback/1.0',
        'Content-Type':  'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    try {
      const result = await githubRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`);
      if (result.status === 404) return res.status(200).json({ stops: [] });
      if (result.status !== 200) return res.status(500).json({ error: 'Failed to read data.' });
      return res.status(200).json(JSON.parse(Buffer.from(result.data.content, 'base64').toString('utf8')));
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  if (req.method === 'POST') {
    const { password, stops } = req.body || {};
    if (!password || password !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
    if (!stops || !Array.isArray(stops)) return res.status(400).json({ error: 'Invalid data.' });
    try {
      const current = await githubRequest('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BRANCH}`);
      if (current.status !== 200) return res.status(500).json({ error: 'Could not fetch file.' });
      const update = await githubRequest('PUT', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, { message: `Update feedback data -- ${new Date().toISOString()}`, content: Buffer.from(JSON.stringify({ stops }, null, 2)).toString('base64'), sha: current.data.sha, branch: BRANCH });
      if (update.status !== 200 && update.status !== 201) return res.status(500).json({ error: 'GitHub write failed.' });
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  return res.status(405).json({ error: 'Method not allowed.' });
};
