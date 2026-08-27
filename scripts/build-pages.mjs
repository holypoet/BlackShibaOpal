#!/usr/bin/env node
// ============================================================
// P1-2 商品靜態頁預渲染（v2）
// 用途：從 Supabase 抓全部商品，產生：
//        /p/<id>.html   每件商品的靜態頁（含 OG + schema.org/Product）
//        /c/<slug>.html 各分類的靜態列表頁（裸石／原礦／半成品／成品）
//        /products.html 全商品靜態列表頁
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

// ⚠️ 商品頁是否自動跳轉回首頁。
// false（建議）：商品頁保留完整內容，搜尋引擎與 AI 爬蟲才收得到；
//                訪客看到的是完整商品資訊 + 明顯的「查看完整商品」按鈕。
// true ：還原舊行為（一載入就 location.replace 回首頁）。
//        注意：開啟後 Google 會把 /p/*.html 視為轉址頁，幾乎不會收錄。
const AUTO_REDIRECT = false;

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

const ntd = n => 'NT$' + (Number(n) || 0).toLocaleString('zh-TW');

// 規格表：只列出實際有值的欄位，讓靜態頁有足夠的可索引文字
const SPEC_FIELDS = [
  ['variety',        '品種'],
  ['country',        '國家'],
  ['origin',         '產地'],
  ['body_tone',      '體色 Body Tone'],
  ['play_of_colour', '遊彩 Play of Colour'],
  ['diaphaneity',    '透明度'],
  ['absorbency',     '吸水性'],
  ['treatment',      '處理方式'],
  ['weight',         '重量'],
  ['size',           '尺寸'],
  ['gaa_source',     '鑑定資訊'],
];
const specRows = p => SPEC_FIELDS
  .filter(([k]) => p[k])
  .map(([k, label]) =>
    `    <tr><th>${esc(label)}</th><td>${esc(p[k])}</td></tr>`).join('\n');

// ---- 分類定義（slug 用英文，避免中文檔名在各家主機出問題）----
const CATEGORIES = [
  { slug: 'loose',    name: '裸石',   en: 'Loose Stones',
    match: c => c === '裸石',
    intro: '澳洲直採天然蛋白石裸石，每顆皆標示產地、體色與遊彩表現，可自行鑲嵌或收藏。' },
  { slug: 'raw',      name: '原礦',   en: 'Rough / Raw',
    match: c => c === '原礦',
    intro: '未經切磨的天然蛋白石原礦，保留開採時的原始樣貌，適合自行切磨或收藏。' },
  { slug: 'semi',     name: '半成品', en: 'Semi-finished',
    match: c => c === '半成品',
    intro: '已完成部分加工的蛋白石，可依需求接續製作成成品珠寶。' },
  { slug: 'finished', name: '成品',   en: 'Finished Jewellery',
    match: c => (c || '').startsWith('成品'),
    intro: '以天然蛋白石手工製作的成品珠寶，包含戒指、項鍊、耳環與手環。' },
];

// ============================================================
// 共用版型
// ============================================================
const SHARED_CSS = `
:root{--bg:#08080d;--bg2:#0e0c16;--bg3:#13101e;--text:#e0dbd0;--muted:#8a8496;
      --accent:#9b85d8;--border:#26223a}
*{box-sizing:border-box}
body{font-family:Georgia,"Times New Roman",serif;background:var(--bg);color:var(--text);
     margin:0;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:2rem 1.25rem 4rem}
header.site{border-bottom:1px solid var(--border);padding:1.25rem;text-align:center}
header.site .brand{font-size:15px;letter-spacing:4px;color:var(--text)}
header.site .tag{font-size:11px;letter-spacing:2px;color:var(--muted);margin-top:4px}
nav.cats{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;
         padding:1rem;border-bottom:1px solid var(--border)}
nav.cats a{font-size:11px;letter-spacing:2px;padding:6px 16px;border:1px solid var(--border);
           color:var(--muted)}
nav.cats a:hover,nav.cats a[aria-current]{border-color:#5a5078;color:var(--accent);
           background:var(--bg3);text-decoration:none}
h1{font-size:1.6rem;font-weight:400;letter-spacing:1px;margin:1.5rem 0 .5rem}
.lede{color:var(--muted);font-size:14px;max-width:640px;margin-bottom:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.25rem}
.item{border:1px solid var(--border);background:var(--bg2);overflow:hidden;
      display:flex;flex-direction:column}
.item img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--bg3)}
.item .body{padding:.85rem 1rem 1rem}
.item .cat{font-size:9px;letter-spacing:2px;color:var(--muted);text-transform:uppercase}
.item .name{font-size:14px;margin:.25rem 0}
.item .spec{font-size:11px;color:var(--muted)}
.item .price{font-size:14px;color:var(--accent);margin-top:.4rem}
.item .sold{font-size:11px;color:var(--muted)}
.empty{color:var(--muted);padding:3rem 0;text-align:center}
footer.site{border-top:1px solid var(--border);padding:2rem 1.25rem;text-align:center;
            color:var(--muted);font-size:12px}
footer.site a{margin:0 8px}
/* 單一商品頁 */
.product{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2.5rem;
         align-items:start;margin-top:1.5rem}
.product img{width:100%;border:1px solid var(--border)}
.product h1{margin-top:0}
.price-lg{font-size:1.5rem;color:var(--accent);margin:.5rem 0 1rem}
table.spec{width:100%;border-collapse:collapse;font-size:13px;margin:1.25rem 0}
table.spec th,table.spec td{text-align:left;padding:.5rem .25rem;
         border-bottom:1px solid var(--border);vertical-align:top}
table.spec th{color:var(--muted);font-weight:400;width:38%;letter-spacing:1px}
.cta{display:inline-block;margin-top:1rem;padding:.85rem 1.75rem;border:1px solid #5a5078;
     color:var(--accent);letter-spacing:2px;font-size:13px}
.cta:hover{background:var(--bg3);text-decoration:none}
@media(max-width:700px){.product{grid-template-columns:1fr;gap:1.5rem}}
`;

const shell = ({ title, desc, canonical, ogImage, jsonld, body, extraHead = '' }) => `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImage)}">
${extraHead}
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>${SHARED_CSS}</style>
</head>
<body>
<header class="site">
  <div class="brand"><a href="${SITE}/">黑柴珠寶 BLACKSHIBAOPAL</a></div>
  <div class="tag">澳洲直採 · 原礦 · 裸石 · 成品</div>
</header>
<nav class="cats">
  <a href="${SITE}/products.html">全部商品</a>
${CATEGORIES.map(c => `  <a href="${SITE}/c/${c.slug}.html">${c.name}</a>`).join('\n')}
</nav>
${body}
<footer class="site">
  <div>
    <a href="${SITE}/">首頁</a>
    <a href="${SITE}/products.html">全部商品</a>
    <a href="${SITE}/guide.html">蛋白石指南</a>
    <a href="${SITE}/guide-grading.html">分級知識</a>
    <a href="${SITE}/opal-tool.html">估價工具</a>
    <a href="${SITE}/about.html">關於我們</a>
  </div>
  <p>黑柴珠寶 BlackShibaOpal｜台灣天然蛋白石專門店</p>
</footer>
</body>
</html>
`;

// 商品卡片（分類頁 / 全商品頁共用）
const cardHtml = p => `  <article class="item">
    <a href="${SITE}/p/${encodeURIComponent(p.id)}.html">
      <img src="${esc(firstImage(p))}" alt="${esc(p.name)}" loading="lazy" width="300" height="300">
    </a>
    <div class="body">
      <div class="cat">${esc(p.category || '')}</div>
      <div class="name"><a href="${SITE}/p/${encodeURIComponent(p.id)}.html">${esc(p.name)}</a></div>
      ${(p.weight || p.size) ? `<div class="spec">${esc([p.weight, p.size ? p.size + ' mm' : ''].filter(Boolean).join(' · '))}</div>` : ''}
      <div class="price">${ntd(p.price)}${isSoldOut(p) ? ' <span class="sold">（已售出／已預定）</span>' : ''}</div>
    </div>
  </article>`;

const listJsonld = (name, desc, url, list) => ({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name, description: desc, url,
  isPartOf: { '@type': 'WebSite', name: '黑柴珠寶 BlackShibaOpal', url: SITE },
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: list.length,
    itemListElement: list.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        url: `${SITE}/p/${encodeURIComponent(p.id)}.html`,
        image: firstImage(p),
        offers: {
          '@type': 'Offer',
          priceCurrency: 'TWD',
          price: String(Number(p.price) || 0),
          availability: isSoldOut(p)
            ? 'https://schema.org/SoldOut'
            : 'https://schema.org/InStock'
        }
      }
    }))
  }
});

// ============================================================
// 1) 每件商品的靜態頁
// ============================================================
await rm('p', { recursive: true, force: true });
await mkdir('p', { recursive: true });

for (const p of products) {
  const url   = `${SITE}/p/${encodeURIComponent(p.id)}.html`;
  const spa   = `${SITE}/?p=${encodeURIComponent(p.id)}`;
  const img   = firstImage(p);
  const desc  = descOf(p);
  const title = `${p.name}｜黑柴珠寶 BlackShibaOpal`;
  const price = Number(p.price) || 0;
  const rows  = specRows(p);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    image: [img],
    description: desc,
    sku: p.id,
    brand: { '@type': 'Brand', name: '黑柴珠寶 BlackShibaOpal' },
    ...(p.variety ? { category: p.variety } : {}),
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'TWD',
      price: String(price),
      availability: isSoldOut(p)
        ? 'https://schema.org/SoldOut'
        : 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: '黑柴珠寶 BlackShibaOpal' }
    }
  };

  const body = `<main class="wrap">
  <article class="product">
    <div><img src="${esc(img)}" alt="${esc(p.name)}" width="600"></div>
    <div>
      <div class="item"><div class="cat" style="border:0;padding:0;background:0">${esc(p.category || '')}</div></div>
      <h1>${esc(p.name)}</h1>
      <div class="price-lg">${ntd(price)}${isSoldOut(p) ? '　<span class="sold">已售出／已預定</span>' : ''}</div>
      <p>${esc(desc)}</p>
${rows ? `      <table class="spec">\n${rows}\n      </table>` : ''}
      <a class="cta" href="${spa}">查看完整商品與遊彩影片 →</a>
    </div>
  </article>
</main>`;

  const html = shell({
    title, desc, canonical: url, ogImage: img, jsonld, body,
    extraHead: '<meta property="og:type" content="product">'
  }) + (AUTO_REDIRECT
    ? `<script>location.replace(${JSON.stringify(spa)});</script>\n`
    : '');

  await writeFile(`p/${p.id}.html`, html);
}
console.log(`已產生 ${products.length} 頁 → /p/${AUTO_REDIRECT ? '（自動轉址：開啟）' : '（自動轉址：關閉，內容可被索引）'}`);

// ============================================================
// 2) 分類靜態頁 /c/<slug>.html
// ============================================================
await rm('c', { recursive: true, force: true });
await mkdir('c', { recursive: true });

for (const cat of CATEGORIES) {
  const list = products.filter(p => cat.match(p.category));
  const url = `${SITE}/c/${cat.slug}.html`;
  const title = `${cat.name}｜澳洲天然蛋白石 ${cat.en}｜黑柴珠寶`;
  const desc = `${cat.intro}目前共 ${list.length} 件商品。`;
  const body = `<main class="wrap">
  <h1>${esc(cat.name)}　<span style="font-size:.7em;color:var(--muted)">${esc(cat.en)}</span></h1>
  <p class="lede">${esc(cat.intro)}目前共 ${list.length} 件商品。</p>
${list.length
    ? `  <div class="grid">\n${list.map(cardHtml).join('\n')}\n  </div>`
    : `  <p class="empty">此分類目前沒有上架中的商品，歡迎<a href="${SITE}/">回首頁</a>看看其他品項。</p>`}
</main>`;

  await writeFile(`c/${cat.slug}.html`, shell({
    title, desc, canonical: url,
    ogImage: list.length ? firstImage(list[0]) : LOGO,
    jsonld: listJsonld(`${cat.name} ${cat.en}`, cat.intro, url, list),
    body
  }));
  console.log(`  /c/${cat.slug}.html → ${list.length} 件`);
}

// ============================================================
// 3) 全商品靜態頁 /products.html
// ============================================================
{
  const url = `${SITE}/products.html`;
  const title = '全部商品｜澳洲天然蛋白石裸石・原礦・成品珠寶｜黑柴珠寶';
  const intro = '黑柴珠寶目前上架的所有天然蛋白石商品，包含澳洲閃電嶺黑蛋白石、Boulder Opal 礫背蛋白石的裸石、原礦與手工珠寶成品。每件皆標示產地、規格與處理方式。';
  const desc = `${intro}目前共 ${products.length} 件。`;
  const body = `<main class="wrap">
  <h1>全部商品</h1>
  <p class="lede">${esc(intro)}目前共 ${products.length} 件。</p>
${products.length
    ? `  <div class="grid">\n${products.map(cardHtml).join('\n')}\n  </div>`
    : `  <p class="empty">目前沒有上架中的商品。</p>`}
</main>`;

  await writeFile('products.html', shell({
    title, desc, canonical: url,
    ogImage: products.length ? firstImage(products[0]) : LOGO,
    jsonld: listJsonld('全部商品', intro, url, products),
    body
  }));
  console.log(`已產生 /products.html（${products.length} 件）`);
}

// ============================================================
// 4) sitemap.xml
// ============================================================
const today = new Date().toISOString().slice(0, 10);
const urlBlock = (loc, lastmod, changefreq, priority, extra = '') => `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>${extra}
  </url>`;

const staticUrls = [
  urlBlock(`${SITE}/`, today, 'weekly', '1.0',
    `\n    <xhtml:link rel="alternate" hreflang="zh-TW" href="${SITE}/"/>` +
    `\n    <xhtml:link rel="alternate" hreflang="en" href="${SITE}/?lang=en"/>`),
  urlBlock(`${SITE}/products.html`, today, 'daily', '0.95'),
  ...CATEGORIES.map(c => urlBlock(`${SITE}/c/${c.slug}.html`, today, 'daily', '0.9')),
  urlBlock(`${SITE}/guide.html`, '2026-06-17', 'monthly', '0.8'),
  urlBlock(`${SITE}/guide-type123.html`, '2026-06-17', 'monthly', '0.8'),
  urlBlock(`${SITE}/guide-where-to-buy.html`, today, 'monthly', '0.9'),
  urlBlock(`${SITE}/guide-grading.html`, today, 'monthly', '0.9'),
  urlBlock(`${SITE}/guide-care.html`, today, 'monthly', '0.9'),
  urlBlock(`${SITE}/opal-tool.html`, today, 'monthly', '0.8'),
  urlBlock(`${SITE}/about.html`, today, 'yearly', '0.7'),
].join('\n');

const productUrls = products.map(p => urlBlock(
  `${SITE}/p/${encodeURIComponent(p.id)}.html`,
  (p.updated_at || p.created_at || '').slice(0, 10) || today,
  'weekly', '0.7'
)).join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${staticUrls}
${productUrls}
</urlset>
`;
await writeFile('sitemap.xml', sitemap);
const totalUrls = 10 + CATEGORIES.length + products.length;
console.log(`sitemap.xml 已更新（${totalUrls} 個網址）`);

// ============================================================
// 5) robots.txt（保留站上原有的 AI 爬蟲開放設定）
// ============================================================
await writeFile('robots.txt', `User-agent: *
Allow: /

# 允許 AI 爬蟲
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
console.log('robots.txt 已更新');

// ============================================================
// 6) 商品圖鏡像備份（防 imgbb 等外部圖床單點故障）
// ============================================================
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
