// Netlify serverless function — fetches Street.co.uk / Rightmove property pages
// server-side so there are no CORS issues from the browser.
// Endpoint: /.netlify/functions/fetch-property?url=https://street.co.uk/...

const https = require('https');
const http = require('http');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://investmentbrochure.netlify.app',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const targetUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!targetUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No URL provided' }) };
  }

  const isStreet = targetUrl.includes('street.co.uk');
  const isRightmove = targetUrl.includes('rightmove.co.uk');

  if (!isStreet && !isRightmove) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only Street.co.uk and Rightmove URLs are supported' }) };
  }

  try {
    const html = await fetchPage(targetUrl);
    const prop = isStreet ? parseStreet(html, targetUrl) : parseRightmove(html, targetUrl);
    return { statusCode: 200, headers, body: JSON.stringify(prop) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Failed to fetch property page' }) };
  }
};

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function parseStreet(html, url) {
  const prop = { source: 'street', photos: [] };
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) {
    const raw = titleM[1].replace(/\s*\|.*$/, '').trim();
    prop.fullTitle = raw;
    const bedM = raw.match(/^(\d+)\s+[Bb]edroom/);
    if (bedM) prop.bedrooms = parseInt(bedM[1]);
    const typeM = raw.match(/\d+\s+[Bb]edroom\s+([\w\s\-]+?),/);
    if (typeM) prop.propertyType = typeM[1].trim();
    const addrM = raw.match(/\d+\s+[Bb]edroom\s+[\w\s\-]+?,\s*(.+)$/);
    if (addrM) prop.address = addrM[1].trim();
    else prop.address = raw;
  }
  const pricePatterns = [
    /Guide Price[^£]*£\s*([\d,]+)/i,
    /Asking Price[^£]*£\s*([\d,]+)/i,
    /For Sale[^£<]*£\s*([\d,]+)/i,
    /"price"[^:]*:\s*"?£?([\d,]+)"?/i,
    /£\s*([\d,]+)\s*<\/h[12]/i,
    /"amount"[^:]*:\s*([\d]+)/i
  ];
  for (const pat of pricePatterns) {
    const m = html.match(pat);
    if (m) { const p = parseInt(m[1].replace(/,/g, '')); if (p > 10000 && p < 100000000) { prop.price = p; break; } }
  }
  const bathM = html.match(/(\d)\s+[Bb]ath/);
  if (bathM) prop.bathrooms = parseInt(bathM[1]);
  const sqftM = html.match(/([\d,]+)\s*sq\.?\s*ft/i);
  if (sqftM) prop.sqft = parseInt(sqftM[1].replace(/,/g, ''));
  const descPatterns = [/Off-Market[^<]{50,}/i, /An exceptional[^<]{50,}/i, /A fantastic[^<]{50,}/i, /<p[^>]*>([A-Z][^<]{100,})<\/p>/];
  for (const pat of descPatterns) {
    const m = html.match(pat);
    if (m) { prop.description = m[0].replace(/<[^>]+>/g, '').trim().substring(0, 500); break; }
  }
  const photoRx = /https:\/\/apollo\.street\.co\.uk\/street-live\/(?:tr:[^/]*\/)?properties\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi;
  const allMatches = [...html.matchAll(photoRx)].map(m => m[0]);
  const seen = new Set(); const fullSize = []; const thumbs = [];
  for (const u of allMatches) {
    const isThumb = u.includes('/tr:'); const filename = u.split('/').pop();
    if (!seen.has(filename)) { seen.add(filename); if (!isThumb) fullSize.push(u); else thumbs.push(u.replace(/\/tr:[^/]+\//, '/')); }
  }
  prop.photos = (fullSize.length > 0 ? fullSize : thumbs).slice(0, 12);
  return prop;
}

function parseRightmove(html, url) {
  const prop = { source: 'rightmove', photos: [] };
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) {
    const raw = titleM[1].replace(/\s*[-|].*Rightmove.*$/i, '').trim();
    prop.address = raw;
    const bedM = raw.match(/(\d+)\s+bedroom/i);
    if (bedM) prop.bedrooms = parseInt(bedM[1]);
    const typeM = raw.match(/\d+\s+bedroom\s+([\w\s-]+?)(?:\s+for sale|\s+to let|,)/i);
    if (typeM) prop.propertyType = typeM[1].trim();
  }
  const priceM = html.match(/["']price["'][^:]*:\s*["']?(\d+)["']?/) || html.match(/£\s*([\d,]+)(?:\s*<|\s*per)/i);
  if (priceM) { const p = parseInt((priceM[1]||'').replace(/,/g, '')); if (p > 10000) prop.price = p; }
  const bathM = html.match(/(\d)\s+bathroom/i);
  if (bathM) prop.bathrooms = parseInt(bathM[1]);
  const photoRx = /https:\/\/media\.rightmove\.co\.uk\/[^\s"'<>]+\.jpg/gi;
  const allPhotos = [...new Set([...html.matchAll(photoRx)].map(m => m[0]))];
  prop.photos = allPhotos.map(u => u.replace(/_\d+x\d+\.jpg$/, '_max_800x600.jpg')).slice(0, 12);
  return prop;
}
