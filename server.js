const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

// Naver RSS URLs - try both .naver and .nhn formats
const NAVER_RSS = {
  main: [
    'https://news.naver.com/main/rss/main.naver',
    'https://news.naver.com/main/rss/main.nhn',
  ],
  politics: [
    'https://news.naver.com/main/rss/main.naver?id=100',
    'https://news.naver.com/main/rss/main.nhn?id=100',
  ],
  economy: [
    'https://news.naver.com/main/rss/main.naver?id=101',
    'https://news.naver.com/main/rss/main.nhn?id=101',
  ],
  society: [
    'https://news.naver.com/main/rss/main.naver?id=102',
    'https://news.naver.com/main/rss/main.nhn?id=102',
  ],
  life: [
    'https://news.naver.com/main/rss/main.naver?id=103',
    'https://news.naver.com/main/rss/main.nhn?id=103',
  ],
  world: [
    'https://news.naver.com/main/rss/main.naver?id=104',
    'https://news.naver.com/main/rss/main.nhn?id=104',
  ],
  it: [
    'https://news.naver.com/main/rss/main.naver?id=105',
    'https://news.naver.com/main/rss/main.nhn?id=105',
  ],
};

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, (res) => {
      console.log(`  [fetch] ${url} -> ${res.statusCode}`);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        console.log(`  [redirect] -> ${redirectUrl}`);
        res.resume();
        fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve(data);
      });
    });
    req.on('error', (err) => {
      console.log(`  [error] ${url}: ${err.message}`);
      reject(err);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
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
    const linkRaw = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                     itemXml.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const link = linkRaw.replace(/&amp;/g, '&').trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const desc = (itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                  itemXml.match(/<description>(.*?)<\/description>/) || [])[1] || '';
    if (title) {
      items.push({ title: title.trim(), link, pubDate, description: desc.trim() });
    }
  }
  return items;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // API: fetch news
  if (parsedUrl.pathname === '/api/news') {
    const category = parsedUrl.searchParams.get('category') || 'main';
    const urls = NAVER_RSS[category] || NAVER_RSS.main;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    console.log(`[news] category=${category}, trying ${urls.length} URLs...`);

    // Try each URL until one works
    for (const rssUrl of urls) {
      try {
        const xml = await fetchUrl(rssUrl);
        const items = parseRssItems(xml).slice(0, 10);
        if (items.length > 0) {
          console.log(`[news] Success! ${items.length} items from ${rssUrl}`);
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', items }));
          return;
        }
        console.log(`[news] No items parsed from ${rssUrl}, trying next...`);
      } catch (err) {
        console.log(`[news] Failed ${rssUrl}: ${err.message}`);
      }
    }

    // All URLs failed
    console.log('[news] All URLs failed');
    res.writeHead(500);
    res.end(JSON.stringify({
      status: 'error',
      message: 'All Naver RSS URLs failed. Check console for details.'
    }));
    return;
  }

  // API: debug - test connectivity
  if (parsedUrl.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const testUrl = 'https://news.naver.com/main/rss/main.naver';
    console.log(`[debug] Testing ${testUrl}...`);
    try {
      const data = await fetchUrl(testUrl);
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        url: testUrl,
        responseLength: data.length,
        first500: data.substring(0, 500),
        hasItems: data.includes('<item>'),
      }));
    } catch (err) {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'error',
        url: testUrl,
        error: err.message,
      }));
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
  console.log(`Debug: http://localhost:${PORT}/api/debug`);
});
