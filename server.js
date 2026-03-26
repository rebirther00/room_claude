const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

// ─── HTTP Fetch utility ───
function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) {
          const p = new URL(url);
          loc = `${p.protocol}//${p.host}${loc}`;
        }
        res.resume();
        return fetchUrl(loc, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── HTML entity decode ───
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// ─── NEWS: Scrape from naver.com ───
async function fetchNews() {
  const strategies = [
    // Strategy 1: Naver main page - extract news headlines
    async () => {
      console.log('[news] Trying naver.com main page...');
      const html = await fetchUrl('https://www.naver.com/');
      const items = [];
      const seen = new Set();

      // Various link patterns on naver.com that point to news articles
      const patterns = [
        // n.news.naver.com links
        /href="(https?:\/\/n\.news\.naver\.com\/[^"]+)"[^>]*>([^<]+)</g,
        // news.naver.com article links
        /href="(https?:\/\/news\.naver\.com\/[^"]*article[^"]*)"[^>]*>([^<]+)</g,
      ];

      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(html)) !== null) {
          const link = decodeEntities(m[1]);
          const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
          if (title.length > 5 && title.length < 200 && !seen.has(title)) {
            seen.add(title);
            items.push({ title, link, source: '네이버뉴스' });
          }
        }
      }
      if (items.length > 0) return items.slice(0, 10);
      throw new Error('No news from naver.com');
    },

    // Strategy 2: Naver news main page
    async () => {
      console.log('[news] Trying news.naver.com...');
      const html = await fetchUrl('https://news.naver.com/');
      const items = [];
      const seen = new Set();

      const pat = /href="(https?:\/\/[^"]*naver\.com[^"]*article[^"]*)"[^>]*>([^<]{5,})/g;
      let m;
      while ((m = pat.exec(html)) !== null) {
        const link = decodeEntities(m[1]);
        const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
        if (title.length > 5 && title.length < 200 && !seen.has(title)) {
          seen.add(title);
          items.push({ title, link, source: '네이버뉴스' });
        }
      }
      if (items.length > 0) return items.slice(0, 10);
      throw new Error('No news from news.naver.com');
    },

    // Strategy 3: Naver news ranking page
    async () => {
      console.log('[news] Trying Naver news ranking...');
      const html = await fetchUrl('https://news.naver.com/main/ranking/popularDay.naver');
      const items = [];
      const seen = new Set();

      const pat = /href="(\/main\/ranking\/read[^"]*|https?:\/\/[^"]*article[^"]*)"[^>]*class="[^"]*"[^>]*>([^<]{5,})/g;
      let m;
      while ((m = pat.exec(html)) !== null) {
        let link = decodeEntities(m[1]);
        if (link.startsWith('/')) link = 'https://news.naver.com' + link;
        const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
        if (title.length > 5 && !seen.has(title)) {
          seen.add(title);
          items.push({ title, link, source: '네이버뉴스' });
        }
      }
      if (items.length > 0) return items.slice(0, 10);
      throw new Error('No news from ranking page');
    },

    // Strategy 4: YTN RSS (backup)
    async () => {
      console.log('[news] Trying YTN RSS...');
      const xml = await fetchUrl('https://www.ytn.co.kr/rss/headline.xml');
      return parseRss(xml, 'YTN');
    },
  ];

  for (const fn of strategies) {
    try {
      const items = await fn();
      if (items.length > 0) {
        console.log(`[news] Got ${items.length} items`);
        return items;
      }
    } catch (err) {
      console.log(`[news] Failed: ${err.message}`);
    }
  }
  throw new Error('All news strategies failed');
}

// ─── STOCKS: Scrape from Naver Finance ───
async function fetchStocks() {
  console.log('[stocks] Fetching from Naver Finance...');

  const indices = [
    { name: 'KOSPI', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI' },
    { name: 'KOSDAQ', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSDAQ' },
  ];

  const usIndices = [
    { name: 'S&P 500', url: 'https://finance.naver.com/world/sise.naver?symbol=SPI@SPX' },
    { name: 'NASDAQ', url: 'https://finance.naver.com/world/sise.naver?symbol=NAS@IXIC' },
    { name: 'DOW', url: 'https://finance.naver.com/world/sise.naver?symbol=DJI@DJI' },
  ];

  const results = [];

  // Korean indices
  for (const idx of indices) {
    try {
      const html = await fetchUrl(idx.url);

      // Extract current price - look for the now_value or similar pattern
      let price = '', change = 0, changePercent = 0;

      // Pattern: <em id="now_value">2,500.00</em>
      const priceMatch = html.match(/id="now_value"[^>]*>([^<]+)/) ||
                          html.match(/class="num"[^>]*>([0-9,.]+)/) ||
                          html.match(/class="no_today"[^>]*>\s*<em[^>]*>([0-9,.]+)/);
      if (priceMatch) price = priceMatch[1].trim();

      // Pattern for change value
      const changeMatch = html.match(/id="change_value_and_rate"[^>]*>([\s\S]*?)<\/em>/);
      if (changeMatch) {
        const nums = changeMatch[1].replace(/<[^>]*>/g, '').trim().split(/\s+/);
        if (nums[0]) change = parseFloat(nums[0].replace(/,/g, '')) || 0;
        if (nums[1]) changePercent = parseFloat(nums[1].replace(/[%()]/g, '')) || 0;
      }

      // Check if up or down
      if (html.includes('ico_down') || html.includes('class="minus"') || html.includes('하락')) {
        change = -Math.abs(change);
        changePercent = -Math.abs(changePercent);
      }

      if (price) {
        results.push({ name: idx.name, price, change: change.toFixed(2), changePercent: changePercent.toFixed(2) });
      }
    } catch (err) {
      console.log(`[stocks] Failed ${idx.name}: ${err.message}`);
    }
  }

  // US indices
  for (const idx of usIndices) {
    try {
      const html = await fetchUrl(idx.url);

      let price = '', change = 0, changePercent = 0;

      // World index pages have different structure
      const priceMatch = html.match(/class="no_today"[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>/) ||
                          html.match(/<em[^>]*class="[^"]*num[^"]*"[^>]*>([0-9,.]+)/) ||
                          html.match(/class="sise_group"[\s\S]*?([0-9][0-9,.]+\.[0-9]+)/);
      if (priceMatch) {
        price = priceMatch[1].replace(/<[^>]*>/g, '').replace(/\s/g, '').trim();
      }

      const changeMatch = html.match(/class="no_exday"[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>/);
      if (changeMatch) {
        change = parseFloat(changeMatch[1].replace(/<[^>]*>/g, '').replace(/,/g, '').trim()) || 0;
        changePercent = parseFloat(changeMatch[2].replace(/<[^>]*>/g, '').replace(/[%]/g, '').trim()) || 0;
      }

      if (html.includes('ico_down') || html.includes('minus')) {
        change = -Math.abs(change);
        changePercent = -Math.abs(changePercent);
      }

      if (price) {
        results.push({ name: idx.name, price, change: change.toFixed(2), changePercent: changePercent.toFixed(2) });
      }
    } catch (err) {
      console.log(`[stocks] Failed ${idx.name}: ${err.message}`);
    }
  }

  if (results.length === 0) throw new Error('No stock data fetched');
  return results;
}

// ─── RSS parser ───
function parseRss(xml, source) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const title = (x.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || x.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const link = (x.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) || x.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    if (title.trim()) items.push({ title: title.trim(), link: decodeEntities(link.trim()), source });
  }
  if (!items.length) throw new Error('No RSS items');
  return items.slice(0, 10);
}

// ─── Server ───
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // API: News
  if (parsedUrl.pathname === '/api/news') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const items = await fetchNews();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', items }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // API: Stocks
  if (parsedUrl.pathname === '/api/stocks') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const items = await fetchStocks();
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', items }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Debug
  if (parsedUrl.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const results = {};
    const urls = ['https://www.naver.com/', 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI'];
    for (const url of urls) {
      try {
        const data = await fetchUrl(url);
        results[url] = { ok: true, length: data.length, preview: data.substring(0, 300) };
      } catch (err) {
        results[url] = { ok: false, error: err.message };
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify(results, null, 2));
    return;
  }

  // Static files
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
