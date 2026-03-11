async function ddgSearch(query) {
  // Step 1: Get vqd token
  const tokenUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(query);
  const tokenRes = await fetch(tokenUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(8000)
  });
  const html = await tokenRes.text();
  const vqdMatch = html.match(/vqd=['"]([^'"]+)/);
  if (!vqdMatch) { console.log('No vqd token found'); console.log('HTML:', html.slice(0, 300)); return; }
  const vqd = vqdMatch[1];
  console.log('vqd:', vqd.slice(0, 20) + '...');

  // Step 2: Get results
  const searchUrl = 'https://links.duckduckgo.com/d.js?q=' + encodeURIComponent(query) + '&vqd=' + vqd + '&kl=wt-wt&l=wt-wt&dl=en&ct=US&ss_mkt=us&s=0&ex=-1&o=json';
  const searchRes = await fetch(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://duckduckgo.com/' },
    signal: AbortSignal.timeout(8000)
  });
  const text = await searchRes.text();
  console.log('Status:', searchRes.status, 'Length:', text.length);

  // Try parse as JSONP
  const jsonpMatch = text.match(/DDG\.pageLayout\.load\('d',(\[[\s\S]*?\])\)/);
  if (jsonpMatch) {
    const results = JSON.parse(jsonpMatch[1]).filter(r => r.u && !r.u.includes('duckduckgo.com'));
    console.log('Results:', results.length);
    for (const r of results.slice(0, 3)) {
      console.log(' -', r.t, '->', r.u?.slice(0, 60));
      console.log('  ', (r.a || '').replace(/<[^>]+>/g, '').slice(0, 100));
    }
    return;
  }

  // Try plain JSON
  try {
    const data = JSON.parse(text);
    const results = (Array.isArray(data) ? data : data.results || []).filter(r => r.u || r.url);
    console.log('JSON results:', results.length);
    for (const r of results.slice(0, 3)) {
      console.log(' -', r.t || r.title, '->', (r.u || r.url || '').slice(0, 60));
    }
  } catch {
    console.log('Raw:', text.slice(0, 500));
  }
}

ddgSearch('AI news 2026').catch(e => console.log('Error:', e.message));
