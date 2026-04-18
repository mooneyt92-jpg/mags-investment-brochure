// Netlify serverless function — fetches Street.co.uk / Rightmove property pages
// server-side so there are no CORS issues from the browser.
// Endpoint: /.netlify/functions/fetch-property?url=https://street.co.uk/...

const https = require('https');
const http = require('http');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const targetUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!targetUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'No URL provided' })
    };
  }

  const isStreet = targetUrl.includes('street.co.uk');
  const isRightmove = targetUrl.includes('rightmove.co.uk');

  if (!isStreet && !isRightmove) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Only Street.co.uk and Rightmove URLs are supported' })
    };
  }

  try {
    const html = await fetchPage(targetUrl);
    
    // Return raw debug info if ?debug=1
    if (event.queryStringParameters && event.queryStringParameters.debug) {
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: 'STATUS: OK\nHTML LENGTH: ' + html.length + '\nFIRST 2000 CHARS:\n' + html.substring(0, 2000)
      };
    }

    let prop;
    if (isStreet) {
      prop = parseStreet(html, targetUrl);
    } else {
      prop = parseRightmove(html, targetUrl);
    }

    // Add debug metadata
    prop._debug = { htmlLength: html.length, url: targetUrl };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(prop)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: err.message || 'Failed to fetch property page',
        stack: err.stack ? err.stack.substring(0, 300) : null,
        url: targetUrl
      })
    };
  }
};

// ── HTTP FETCH ──
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const isRightmove = url.includes('rightmove.co.uk');
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        // Rightmove needs a referer to not block
        ...(isRightmove ? { 'Referer': 'https://www.rightmove.co.uk/' } : {})
      },
      timeout: 12000
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

// ── STREET.CO.UK PARSER ──
function parseStreet(html, url) {
  const prop = { source: 'street', photos: [] };

  // Title: "3 Bedroom Semi Detached House, South Drive, Wavertree, L15 | Street"
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) {
    const raw = titleM[1].replace(/\s*\|.*$/, '').trim();
    prop.fullTitle = raw;
    // Extract bedrooms
    const bedM = raw.match(/^(\d+)\s+[Bb]edroom/);
    if (bedM) prop.bedrooms = parseInt(bedM[1]);
    // Extract property type
    const typeM = raw.match(/\d+\s+[Bb]edroom\s+([\w\s\-]+?),/);
    if (typeM) prop.propertyType = typeM[1].trim();
    // Address is everything after the type
    const addrM = raw.match(/\d+\s+[Bb]edroom\s+[\w\s\-]+?,\s*(.+)$/);
    if (addrM) prop.address = addrM[1].trim();
    else prop.address = raw;
  }

  // Price — multiple patterns
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
    if (m) {
      const p = parseInt(m[1].replace(/,/g, ''));
      if (p > 10000 && p < 100000000) { prop.price = p; break; }
    }
  }

  // Bathrooms
  const bathM = html.match(/(\d)\s+[Bb]ath/);
  if (bathM) prop.bathrooms = parseInt(bathM[1]);

  // Sq ft
  const sqftM = html.match(/([\d,]+)\s*sq\.?\s*ft/i);
  if (sqftM) prop.sqft = parseInt(sqftM[1].replace(/,/g, ''));

  // Description — find the largest text block
  const descPatterns = [
    /class="[^"]*description[^"]*"[^>]*>\s*<[^>]+>([^<]{80,})/i,
    /<p[^>]*>([A-Z][^<]{100,})<\/p>/,
    /Off-Market[^<]{50,}/i,
    /An exceptional[^<]{50,}/i,
    /A fantastic[^<]{50,}/i,
    /This[^<]{100,}/i
  ];
  for (const pat of descPatterns) {
    const m = html.match(pat);
    if (m) { prop.description = m[0].replace(/<[^>]+>/g, '').trim().substring(0, 500); break; }
  }

  // Photos — Street.co.uk uses apollo CDN
  // Full size: apollo.street.co.uk/street-live/properties/general/ID/filename.jpg
  // Thumb: apollo.street.co.uk/street-live/tr:pr-true,n-property_small_fill_crop/properties/...
  const photoRx = /https:\/\/apollo\.street\.co\.uk\/street-live\/(?:tr:[^/]*\/)?properties\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi;
  const allMatches = [...html.matchAll(photoRx)].map(m => m[0]);

  // Prefer full-size (no transform) over thumbnails, deduplicate by filename
  const seen = new Set();
  const fullSize = [];
  const thumbs = [];

  for (const u of allMatches) {
    const isThumb = u.includes('/tr:');
    const filename = u.split('/').pop();
    if (!seen.has(filename)) {
      seen.add(filename);
      if (!isThumb) fullSize.push(u);
      else thumbs.push(u.replace(/\/tr:[^/]+\//, '/'));
    }
  }

  prop.photos = (fullSize.length > 0 ? fullSize : thumbs).slice(0, 12);

  return prop;
}

// ── RIGHTMOVE PARSER ──
function parseRightmove(html, url) {
  const prop = { source: 'rightmove', photos: [] };

  // Try Rightmove embedded JSON first (most reliable)
  const jsonPatterns = [
    /window\.PAGE_MODEL\s*=\s*({.+?});\s*<\/script>/s,
    /window\.__PRELOADED_STATE__\s*=\s*({.+?});\s*<\/script>/s,
  ];
  for (const pat of jsonPatterns) {
    try {
      const m = html.match(pat);
      if (m) {
        const parsed = JSON.parse(m[1]);
        const pd = parsed.propertyData || parsed.property || parsed;
        if (pd.address) prop.address = pd.address.displayAddress || pd.address.outcode || JSON.stringify(pd.address);
        if (pd.prices) prop.price = pd.prices.primaryPrice ? parseInt(pd.prices.primaryPrice.replace(/[^0-9]/g, '')) : null;
        if (pd.bedrooms) prop.bedrooms = pd.bedrooms;
        if (pd.bathrooms) prop.bathrooms = pd.bathrooms;
        if (pd.propertySubType) prop.propertyType = pd.propertySubType;
        if (pd.text && pd.text.description) prop.description = pd.text.description.substring(0, 500);
        if (pd.images && pd.images.length) {
          prop.photos = pd.images.map(img => img.srcUrl || img.url || '').filter(Boolean).slice(0, 12);
        }
        if (prop.address || prop.price) break;
      }
    } catch(e) {}
  }

  // Fallback: HTML patterns
  if (!prop.address) {
    const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleM) {
      const raw = titleM[1].replace(/\s*[-|].*Rightmove.*$/i, '').replace(/\s*on Rightmove.*$/i, '').trim();
      prop.address = raw;
      const bedM = raw.match(/(\d+)\s+bedroom/i);
      if (bedM) prop.bedrooms = parseInt(bedM[1]);
      const typeM = raw.match(/\d+\s+bedroom\s+([\w\s-]+?)(?:\s+for sale|\s+to let|,|$)/i);
      if (typeM) prop.propertyType = typeM[1].trim();
    }
  }

  if (!prop.price) {
    const pricePatterns = [
      /"price"\s*:\s*\{\s*"amount"\s*:\s*(\d+)/,
      /"amount"\s*:\s*(\d+),\s*"currencyCode"\s*:\s*"GBP"/,
      /"displayPrice"\s*:\s*"£([\d,]+)"/i,
      /£\s*([\d,]+)\s*(?:<\/span>|<\/p>|<\/h)/i
    ];
    for (const pat of pricePatterns) {
      const m = html.match(pat);
      if (m) { const p = parseInt(m[1].replace(/,/g, '')); if (p > 10000 && p < 100000000) { prop.price = p; break; } }
    }
  }

  if (!prop.bedrooms) {
    const bedM = html.match(/(\d+)\s+bedroom/i) || html.match(/"bedrooms"\s*:\s*(\d+)/);
    if (bedM) prop.bedrooms = parseInt(bedM[1]);
  }

  if (!prop.bathrooms) {
    const bathM = html.match(/(\d+)\s+bathroom/i) || html.match(/"bathrooms"\s*:\s*(\d+)/);
    if (bathM) prop.bathrooms = parseInt(bathM[1]);
  }

  if (!prop.photos.length) {
    const allPhotos = new Set();

    // Pattern 1: property-photo CDN (the main one seen in the HTML)
    // e.g. https://media.rightmove.co.uk/property-photo/7ce45b02c/174617249/abc123.jpeg
    for (const m of html.matchAll(/https:\/\/media\.rightmove\.co\.uk\/property-photo\/[^\s"'<>]+\.(?:jpe?g|png|webp)/gi)) {
      allPhotos.add(m[0]);
    }

    // Pattern 2: preload link tags (highest priority photos Rightmove preloads)
    for (const m of html.matchAll(/rel="preload"[^>]*href="(https:\/\/media\.rightmove\.co\.uk[^"]+\.(?:jpe?g|png))"/gi)) {
      allPhotos.add(m[1]);
    }

    // Pattern 3: dir/ pattern (older Rightmove format)
    for (const m of html.matchAll(/https:\/\/media\.rightmove\.co\.uk\/dir\/[^\s"'<>]+\.(?:jpe?g|png)/gi)) {
      const u = m[0];
      if (!u.includes('_thumb') && !u.includes('agent') && !u.includes('logo') && !u.includes('favicon')) {
        allPhotos.add(u);
      }
    }

    // Pattern 4: srcUrl in JSON
    for (const m of html.matchAll(/"srcUrl"\s*:\s*"(https:\/\/media\.rightmove\.co\.uk[^"]+)"/gi)) {
      allPhotos.add(m[1]);
    }

    // Pattern 5: generic media.rightmove jpg/jpeg — filter out icons/logos
    for (const m of html.matchAll(/https:\/\/media\.rightmove\.co\.uk\/[^\s"'<>]+\.(?:jpe?g|png)/gi)) {
      const u = m[0];
      if (!u.includes('favicon') && !u.includes('app-icon') && !u.includes('logo') && 
          !u.includes('assets') && !u.includes('shared-assets') && !u.includes('_thumb') &&
          !u.includes('agent') && !u.includes('brand')) {
        allPhotos.add(u);
      }
    }

    prop.photos = [...allPhotos].slice(0, 12);
  }

  return prop;
}
