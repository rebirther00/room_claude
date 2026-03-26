const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
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
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse Naver news ranking page to extract headlines
function parseNaverNews(html) {
  const items = [];

  // Pattern 1: news headline links with titles
  // Naver uses various patterns, try multiple
  const patterns = [
    // News ranking items: <a ...class="...list_title..."...>title</a>
    /<a[^>]*href="(https?:\/\/[^"]*article[^"]*)"[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    // Generic news links
    /<a[^>]*href="(https?:\/\/n\.news\.naver\.com[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    // News home headline items
    /<a[^>]*href="(https?:\/\/news\.naver\.com[^"]*article[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];

  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const link = match[1].replace(/&amp;/g, '&');
      const rawTitle = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (rawTitle.length > 8 && rawTitle.length < 200 && !seen.has(rawTitle)) {
        seen.add(rawTitle);
        items.push({ title: rawTitle, link });
      }
    }
  }
  return items;
}

// Parse Naver news ranking API response
function parseNaverRanking(json) {
  const items = [];
  try {
    const data = JSON.parse(json);
    // Try various response shapes
    const articleList = data.articleList || data.airsResult?.result?.articleList || [];
    for (const article of articleList) {
      if (article.title) {
        items.push({
          title: article.title.replace(/<[^>]*>/g, '').trim(),
          link: article.url || `https://n.news.naver.com/article/${article.officeId}/${article.articleId}`,
          pubDate: article.datetime || '',
        });
      }
    }
  } catch {}
  return items;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (parsedUrl.pathname === '/api/news') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const strategies = [
      // Strategy 1: Naver news ranking API (JSON)
      async () => {
        console.log('[news] Trying Naver ranking API...');
        const json = await fetchUrl('https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=&date=');
        const items = parseNaverRanking(json);
        if (items.length > 0) return items;
        throw new Error('No items from ranking API');
      },
      // Strategy 2: Scrape Naver news main page
      async () => {
        console.log('[news] Trying Naver news main page scrape...');
        const html = await fetchUrl('https://news.naver.com/');
        const items = parseNaverNews(html);
        if (items.length > 0) return items;
        throw new Error('No items scraped from main page');
      },
      // Strategy 3: Scrape Naver main page news section
      async () => {
        console.log('[news] Trying Naver main page...');
        const html = await fetchUrl('https://www.naver.com/');
        const items = parseNaverNews(html);
        if (items.length > 0) return items;
        throw new Error('No items from naver.com');
      },
      // Strategy 4: YTN RSS (reliable Korean news backup)
      async () => {
        console.log('[news] Trying YTN RSS as fallback...');
        const xml = await fetchUrl('https://www.ytn.co.kr/rss/headline.xml');
        return parseRssItems(xml);
      },
      // Strategy 5: SBS RSS
      async () => {
        console.log('[news] Trying SBS RSS as fallback...');
        const xml = await fetchUrl('https://news.sbs.co.kr/news/SSection.do?action=rss&section=01');
        return parseRssItems(xml);
      },
    ];

    for (const strategy of strategies) {
      try {
        const items = await strategy();
        if (items.length > 0) {
          console.log(`[news] Success! ${items.length} items`);
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', items: items.slice(0, 10) }));
          return;
        }
      } catch (err) {
        console.log(`[news] Strategy failed: ${err.message}`);
      }
    }

    console.log('[news] All strategies failed');
    res.writeHead(500);
    res.end(JSON.stringify({ status: 'error', message: 'All news sources failed' }));
    return;
  }

  // Debug endpoint
  if (parsedUrl.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const results = {};

    const testUrls = [
      'https://news.naver.com/',
      'https://www.naver.com/',
      'https://www.ytn.co.kr/rss/headline.xml',
    ];

    for (const url of testUrls) {
      try {
        const data = await fetchUrl(url);
        results[url] = { status: 'ok', length: data.length, preview: data.substring(0, 300) };
      } catch (err) {
        results[url] = { status: 'error', error: err.message };
      }
    }

    res.writeHead(200);
    res.end(JSON.stringify(results, null, 2));
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
    if (title.trim()) {
      items.push({ title: title.trim(), link, pubDate });
    }
  }
  if (items.length === 0) throw new Error('No RSS items found');
  return items;
}

server.listen(PORT, () => {
  console.log(`Homepage server running at http://localhost:${PORT}`);
  console.log(`Debug: http://localhost:${PORT}/api/debug`);
});
