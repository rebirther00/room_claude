const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

const NAVER_RSS = {
  main: 'https://news.naver.com/main/rss/main.nhn',
  politics: 'https://news.naver.com/main/rss/main.nhn?id=100',
  economy: 'https://news.naver.com/main/rss/main.nhn?id=101',
  society: 'https://news.naver.com/main/rss/main.nhn?id=102',
  life: 'https://news.naver.com/main/rss/main.nhn?id=103',
  world: 'https://news.naver.com/main/rss/main.nhn?id=104',
  it: 'https://news.naver.com/main/rss/main.nhn?id=105',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const linkRaw = (itemXml.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const link = linkRaw.replace(/&amp;/g, '&');
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const desc = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                  itemXml.match(/<description>(.*?)<\/description>/) || [])[1] || '';
    if (title) {
      items.push({ title: title.trim(), link: link.trim(), pubDate, description: desc.trim() });
    }
  }
  return items;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // API: fetch news
  if (parsedUrl.pathname === '/api/news') {
    const category = parsedUrl.searchParams.get('category') || 'main';
    const rssUrl = NAVER_RSS[category] || NAVER_RSS.main;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      const xml = await fetchUrl(rssUrl);
      const items = parseRssItems(xml).slice(0, 10);
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', items }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Serve static files
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Homepage server running at http://localhost:${PORT}`);
});
