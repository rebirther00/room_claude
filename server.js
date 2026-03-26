const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

// ─── HTTP Fetch ───
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
        'Referer': 'https://www.naver.com/',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const p = new URL(url); loc = `${p.protocol}//${p.host}${loc}`; }
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

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// ═══════════════════════════════════════
// NEWS: Multiple strategies
// ═══════════════════════════════════════
async function fetchNews() {
  const strategies = [
    // Strategy 1: Naver news section list pages (server-rendered, most reliable)
    async () => {
      console.log('[news] Trying Naver news list page...');
      const html = await fetchUrl('https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=001');
      return parseNaverNewsList(html);
    },

    // Strategy 2: Naver main page
    async () => {
      console.log('[news] Trying naver.com...');
      const html = await fetchUrl('https://www.naver.com/');
      return parseNaverMainPage(html);
    },

    // Strategy 3: Naver news main
    async () => {
      console.log('[news] Trying news.naver.com...');
      const html = await fetchUrl('https://news.naver.com/');
      return parseNewsNaverPage(html);
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

function parseNaverNewsList(html) {
  const items = [];
  const seen = new Set();
  // Naver list pages: <a href="..." class="nclicks...">title</a> inside <ul class="type06_headline">
  // Also: <dt> or <a> tags with article links
  const patterns = [
    /href="(https?:\/\/n\.news\.naver\.com\/[^"]+)"[^>]*>\s*([^<]{5,})/g,
    /href="(https?:\/\/news\.naver\.com\/[^"]*article[^"]*)"[^>]*>\s*([^<]{5,})/g,
    /href="(\/main\/read\.naver[^"]*)"[^>]*>\s*([^<]{5,})/g,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(html)) !== null) {
      let link = decodeEntities(m[1].trim());
      if (link.startsWith('/')) link = 'https://news.naver.com' + link;
      const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
      if (title.length > 8 && title.length < 200 && !seen.has(title)) {
        seen.add(title);
        items.push({ title, link, source: '네이버뉴스' });
      }
    }
  }
  if (!items.length) throw new Error('No items from list page');
  return items.slice(0, 10);
}

function parseNaverMainPage(html) {
  const items = [];
  const seen = new Set();
  const patterns = [
    /href="(https?:\/\/n\.news\.naver\.com\/[^"]+)"[^>]*>([^<]{5,})/g,
    /href="(https?:\/\/news\.naver\.com\/[^"]*article[^"]*)"[^>]*>([^<]{5,})/g,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(html)) !== null) {
      const link = decodeEntities(m[1]);
      const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
      if (title.length > 8 && title.length < 200 && !seen.has(title)) {
        seen.add(title);
        items.push({ title, link, source: '네이버뉴스' });
      }
    }
  }
  if (!items.length) throw new Error('No items from naver.com');
  return items.slice(0, 10);
}

function parseNewsNaverPage(html) {
  const items = [];
  const seen = new Set();
  // sa_text_title class or hdline_article_tit class
  const pat = /href="(https?:\/\/[^"]*naver\.com[^"]*(?:article|read)[^"]*)"[^>]*>[\s\S]*?(?:<strong[^>]*>)?([^<]{5,})/g;
  let m;
  while ((m = pat.exec(html)) !== null) {
    const link = decodeEntities(m[1]);
    const title = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (title.length > 8 && title.length < 200 && !seen.has(title)) {
      seen.add(title);
      items.push({ title, link, source: '네이버뉴스' });
    }
  }
  if (!items.length) throw new Error('No items from news.naver.com');
  return items.slice(0, 10);
}

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

// ═══════════════════════════════════════
// STOCKS: Naver Finance JSON APIs (most reliable)
// ═══════════════════════════════════════
async function fetchStocks() {
  const results = [];

  // ── Korean indices via Naver mobile stock API ──
  const krIndices = [
    { name: 'KOSPI', code: 'KOSPI' },
    { name: 'KOSDAQ', code: 'KOSDAQ' },
  ];

  for (const idx of krIndices) {
    try {
      console.log(`[stocks] Fetching ${idx.name}...`);
      const json = await fetchUrl(`https://m.stock.naver.com/api/index/${idx.code}/basic`);
      const data = JSON.parse(json);
      const price = data.closePrice || data.nowVal || '';
      const change = data.compareToPreviousClosePrice || data.changeVal || '0';
      const changeRate = data.fluctuationsRatio || data.changeRate || '0';
      if (price) {
        results.push({
          name: idx.name,
          price: price,
          change: parseFloat(String(change).replace(/,/g, '')) || 0,
          changePercent: parseFloat(String(changeRate).replace(/[%]/g, '')) || 0,
        });
      }
    } catch (err) {
      console.log(`[stocks] ${idx.name} API failed: ${err.message}`);
      // Fallback: try HTML scraping
      try {
        const html = await fetchUrl(`https://finance.naver.com/sise/sise_index.naver?code=${idx.code}`);
        const priceMatch = html.match(/id="now_value"[^>]*>([^<]+)/);
        if (priceMatch) {
          let change = 0, changePercent = 0;
          const changeMatch = html.match(/id="change_value_and_rate"[^>]*>([\s\S]*?)<\/em>/);
          if (changeMatch) {
            const nums = changeMatch[1].replace(/<[^>]*>/g, '').trim().split(/\s+/);
            change = parseFloat((nums[0] || '0').replace(/,/g, '')) || 0;
            changePercent = parseFloat((nums[1] || '0').replace(/[%()]/g, '')) || 0;
          }
          if (html.includes('ico_down') || html.includes('minus')) {
            change = -Math.abs(change);
            changePercent = -Math.abs(changePercent);
          }
          results.push({ name: idx.name, price: priceMatch[1].trim(), change, changePercent });
        }
      } catch (e2) {
        console.log(`[stocks] ${idx.name} HTML fallback also failed: ${e2.message}`);
      }
    }
  }

  // ── US indices via Naver mobile stock API ──
  const usIndices = [
    { name: 'S&P 500', symbol: '.SPX' },
    { name: 'NASDAQ', symbol: '.IXIC' },
    { name: 'DOW', symbol: '.DJI' },
  ];

  for (const idx of usIndices) {
    try {
      console.log(`[stocks] Fetching ${idx.name}...`);
      const json = await fetchUrl(`https://m.stock.naver.com/api/index/${encodeURIComponent(idx.symbol)}/basic`);
      const data = JSON.parse(json);
      const price = data.closePrice || data.nowVal || '';
      const change = data.compareToPreviousClosePrice || data.changeVal || '0';
      const changeRate = data.fluctuationsRatio || data.changeRate || '0';
      if (price) {
        results.push({
          name: idx.name,
          price: price,
          change: parseFloat(String(change).replace(/,/g, '')) || 0,
          changePercent: parseFloat(String(changeRate).replace(/[%]/g, '')) || 0,
        });
      }
    } catch (err) {
      console.log(`[stocks] ${idx.name} failed: ${err.message}`);
      // Fallback: HTML scraping from world sise page
      const symbolMap = { '.SPX': 'SPI@SPX', '.IXIC': 'NAS@IXIC', '.DJI': 'DJI@DJI' };
      try {
        const html = await fetchUrl(`https://finance.naver.com/world/sise.naver?symbol=${symbolMap[idx.symbol]}`);
        const pm = html.match(/class="no_today"[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>/);
        if (pm) {
          const price = pm[1].replace(/<[^>]*>/g, '').replace(/\s/g, '').trim();
          let change = 0, changePercent = 0;
          const cm = html.match(/class="no_exday"[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>[\s\S]*?<em[^>]*>([\s\S]*?)<\/em>/);
          if (cm) {
            change = parseFloat(cm[1].replace(/<[^>]*>/g, '').replace(/,/g, '').trim()) || 0;
            changePercent = parseFloat(cm[2].replace(/<[^>]*>/g, '').replace(/[%]/g, '').trim()) || 0;
          }
          if (html.includes('ico_down') || html.includes('minus')) {
            change = -Math.abs(change); changePercent = -Math.abs(changePercent);
          }
          results.push({ name: idx.name, price, change, changePercent });
        }
      } catch (e2) {
        console.log(`[stocks] ${idx.name} HTML fallback also failed: ${e2.message}`);
      }
    }
  }

  if (!results.length) throw new Error('No stock data');
  return results;
}

// ═══════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

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

  if (parsedUrl.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const results = {};
    const tests = [
      ['Naver Main', 'https://www.naver.com/'],
      ['Naver News List', 'https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=001'],
      ['KOSPI API', 'https://m.stock.naver.com/api/index/KOSPI/basic'],
      ['KOSPI HTML', 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI'],
    ];
    for (const [name, url] of tests) {
      try {
        const data = await fetchUrl(url);
        results[name] = { ok: true, length: data.length, preview: data.substring(0, 500) };
      } catch (err) {
        results[name] = { ok: false, error: err.message };
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
  const mime = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  };
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
  console.log(`Debug: http://localhost:${PORT}/api/debug`);
});
