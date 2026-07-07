#!/usr/bin/env node
// ============================================================
// P1-2 商品靜態頁預渲染
// 用途：從 Supabase 抓全部商品，為每件商品產生 /p/<id>.html
//      （含 OG 分享預覽 + schema.org/Product 結構化資料），
//      並重建 sitemap.xml 與 robots.txt。
// 執行：node scripts/build-pages.mjs（由 GitHub Actions 自動跑）
// ============================================================

import { mkdir, writeFile, rm } from 'node:fs/promises';

const SB_URL = 'https://obujbaevimyquefwgnxm.supabase.co';
// 讀商品只需要公開的 publishable key（products 對 anon 開放 SELECT，
// 這把 key 本來就公開在前台頁面裡，放這裡不增加風險）。
// 若日後收緊讀取權限，在 GitHub Secrets 設 SUPABASE_KEY 即可覆蓋。
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jdHW-a9YVioP2VQh4Besuw_Z8J95PWi';

const SITE = 'https://blackshibaopal.com';
const LOGO = `${SITE}/logo.jpg`;

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---- 抓商品 ----
const res = await fetch(`${SB_URL}/rest/v1/products?select=*&order=created_at.desc`, {
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
});
if (!res.ok) {
  console.error('抓取商品失敗:', res.status, await res.text());
  process.exit(1);
}
const products = await res.json();
console.log(`抓到 ${products.length} 件商品`);

// ---- 小工具 ----
const firstImage = p => {
  const imgs = Array.isArray(p.images) && p.images.length
    ? p.images
    : (p.image ? [{ src: p.image }] : []);
  // 只取 http(s) 圖片；base64 圖不能當 og:image，改用 logo
  const hit = imgs.map(i => i && i.src).find(u => u && /^https?:\/\//.test(u));
  return hit || LOGO;
};

const descOf = p => {
  const d = (p.description || p.desc || '').replace(/\s+/g, ' ').trim();
  if (d) return d.slice(0, 150);
  const spec = [p.variety, p.origin || p.country, p.weight, p.size]
    .filter(Boolean).join('・');
  return (spec || '澳洲天然蛋白石').slice(0, 150);
};

const isSoldOut = p =>
  !(Number(p.stock) > 0) || p.status === '已售出' || p.status === '已預定';

// ---- 產生每商品靜態頁 ----
await rm('p', { recursive: true, force: true });
await mkdir('p', { recursive: true });

for (const p of products) {
  const url   = `${SITE}/p/${p.id}.html`;
  const img   = firstImage(p);
  const desc  = descOf(p);
  const title = `${p.name}｜黑柴珠寶 BlackShibaOpal`;
  const price = Number(p.price) || 0;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    image: [img],
    description: desc,
    sku: p.id,
    brand: { '@type': 'Brand', name: '黑柴珠寶 BlackShibaOpal' },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'TWD',
      price: String(price),
      availability: isSoldOut(p)
        ? 'https://schema.org/SoldOut'
        : 'https://schema.org/InStock'
    }
  };

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(img)}">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>
body{font-family:Georgia,serif;background:#08080d;color:#e0dbd0;margin:0;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{max-width:480px;padding:2rem;text-align:center}
img{max-width:100%;border-radius:8px}
a{color:#9b85d8}
</style>
</head>
<body>
<div class="box">
  <img src="${esc(img)}" alt="${esc(p.name)}" width="480">
  <h1>${esc(p.name)}</h1>
  <p>NT$${price.toLocaleString('zh-TW')}${isSoldOut(p) ? '（已售出／已預定）' : ''}</p>
  <p>${esc(desc)}</p>
  <p><a href="${SITE}/?p=${encodeURIComponent(p.id)}">前往黑柴珠寶查看商品 →</a></p>
</div>
<script>location.replace('${SITE}/?p=${encodeURIComponent(p.id)}');</script>
</body>
</html>
`;
  await writeFile(`p/${p.id}.html`, html);
}
console.log(`已產生 ${products.length} 頁 → /p/`);

// ---- sitemap.xml ----
const today = new Date().toISOString().slice(0, 10);
const staticUrls = `  <url>
    <loc>${SITE}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="zh-TW" href="${SITE}/"/>
    <xhtml:link rel="alternate" hreflang="en" href="${SITE}/?lang=en"/>
  </url>
  <url>
    <loc>${SITE}/guide.html</loc>
    <lastmod>2026-06-17</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${SITE}/guide-type123.html</loc>
    <lastmod>2026-06-17</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
const productUrls = products.map(p => `  <url>
    <loc>${SITE}/p/${p.id}.html</loc>
    <lastmod>${(p.updated_at || p.created_at || '').slice(0, 10) || today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`).join('\n');
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${staticUrls}
${productUrls}
</urlset>
`;
await writeFile('sitemap.xml', sitemap);
console.log(`sitemap.xml 已更新（${3 + products.length} 個網址）`);

// ---- robots.txt（保留站上原有的 AI 爬蟲開放設定）----
await writeFile('robots.txt', `User-agent: *
Allow: /

# 允許 AI 爬蟲
User-agent: GPTBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Googlebot
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
console.log('robots.txt 已更新');

// ---- 商品圖鏡像備份（防 imgbb 等外部圖床單點故障）----
// 只備份 http(s) 外部圖片；已存在的檔案跳過（以網址雜湊命名，天然去重）
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';

await mkdir('backup/images', { recursive: true });
let backed = 0, skipped = 0, failed = 0;
for (const p of products) {
  const imgs = Array.isArray(p.images) && p.images.length
    ? p.images.map(i => i && i.src)
    : (p.image ? [p.image] : []);
  for (const u of imgs) {
    if (!u || !/^https?:\/\//.test(u)) continue;
    const ext = (u.match(/\.(jpe?g|png|webp|gif)(\?|$)/i) || [,'jpg'])[1].toLowerCase();
    const name = createHash('md5').update(u).digest('hex') + '.' + ext;
    const path = `backup/images/${name}`;
    try { await access(path); skipped++; continue; } catch {}
    try {
      const r = await fetch(u);
      if (!r.ok) { failed++; continue; }
      await writeFile(path, Buffer.from(await r.arrayBuffer()));
      backed++;
    } catch { failed++; }
  }
}
console.log(`圖片備份：新增 ${backed}、已存在 ${skipped}、失敗 ${failed}`);
