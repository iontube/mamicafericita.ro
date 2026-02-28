#!/usr/bin/env node

/**
 * Generate WordPress-style sitemaps for mamicafericita.ro
 * Creates:
 * - sitemap_index.xml (main index)
 * - post-sitemap.xml (articles with images)
 * - category-sitemap.xml (category pages)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SITE_URL = 'https://mamicafericita.ro';

// Get current date in ISO format
const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

// Categories
const categories = [
  { name: 'Carucioare si Accesorii Bebe', slug: 'carucioare-accesorii-bebe' },
  { name: 'Jucarii Educative', slug: 'jucarii-educative' },
  { name: 'Alimentatie si Nutritie Copii', slug: 'alimentatie-nutritie-copii' },
  { name: 'Produse pentru Mamici', slug: 'produse-mamici' },
  { name: 'Camera Copilului', slug: 'camera-copilului' }
];

// Read keywords.json to get articles
function getArticles() {
  const keywordsPath = path.join(ROOT_DIR, 'keywords.json');
  const keywordsData = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
  return keywordsData.completed || [];
}

// Slugify function
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ăâ]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[șş]/g, 's')
    .replace(/[țţ]/g, 't')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Get the most recent article date (prefers modifiedDate over date)
function getLatestArticleDate() {
  const articles = getArticles();
  if (articles.length === 0) return now;
  const dates = articles
    .filter(a => a.date || a.modifiedDate)
    .map(a => new Date(a.modifiedDate || a.date).getTime());
  if (dates.length === 0) return now;
  return new Date(Math.max(...dates)).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// Generate sitemap index (only articles and categories)
function generateSitemapIndex() {
  const latestDate = getLatestArticleDate();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<sitemap>
		<loc>${SITE_URL}/post-sitemap.xml</loc>
		<lastmod>${latestDate}</lastmod>
	</sitemap>
	<sitemap>
		<loc>${SITE_URL}/category-sitemap.xml</loc>
		<lastmod>${latestDate}</lastmod>
	</sitemap>
</sitemapindex>`;

  fs.writeFileSync(path.join(DIST_DIR, 'sitemap_index.xml'), xml);
  console.log('Created: sitemap_index.xml');
}

// Generate post sitemap with images
function generatePostSitemap() {
  const articles = getArticles();

  // Sort by date descending (newest first)
  articles.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });

  let urlEntries = '';

  for (const article of articles) {
    const slug = slugify(article.keyword);
    const imagePath = `/images/articles/${slug}.webp`;

    // Check if image exists
    const imageFullPath = path.join(DIST_DIR, 'images', 'articles', `${slug}.webp`);
    const hasImage = fs.existsSync(imageFullPath);

    const articleDate = (article.modifiedDate || article.date)
      ? new Date(article.modifiedDate || article.date).toISOString().replace(/\.\d{3}Z$/, '+00:00')
      : now;

    urlEntries += `
	<url>
		<loc>${SITE_URL}/${slug}/</loc>
		<lastmod>${articleDate}</lastmod>${hasImage ? `
		<image:image>
			<image:loc>${SITE_URL}${imagePath}</image:loc>
		</image:image>` : ''}
	</url>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urlEntries}
</urlset>`;

  fs.writeFileSync(path.join(DIST_DIR, 'post-sitemap.xml'), xml);
  console.log(`Created: post-sitemap.xml (${articles.length} articles)`);
}

// Generate category sitemap
function generateCategorySitemap() {
  let urlEntries = '';

  for (const cat of categories) {
    urlEntries += `
	<url>
		<loc>${SITE_URL}/${cat.slug}/</loc>
		<lastmod>${now}</lastmod>
	</url>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}
</urlset>`;

  fs.writeFileSync(path.join(DIST_DIR, 'category-sitemap.xml'), xml);
  console.log(`Created: category-sitemap.xml (${categories.length} categories)`);
}

// Generate XSL stylesheet for pretty sitemap display
function generateSitemapXsl() {
  const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>XML Sitemap - MamicaFericita.ro</title>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <style type="text/css">
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #be185d; border-bottom: 3px solid #ec4899; padding-bottom: 10px; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e5e7eb; }
    th { background: #fdf2f8; font-weight: 600; }
    tr:hover { background: #fdf2f8; }
    a { color: #db2777; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .count { background: #ec4899; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>XML Sitemap</h1>
  <xsl:choose>
    <xsl:when test="sitemap:sitemapindex">
      <p>Acest sitemap index contine <span class="count"><xsl:value-of select="count(sitemap:sitemapindex/sitemap:sitemap)"/></span> sitemap-uri.</p>
      <table>
        <tr><th>Sitemap</th><th>Ultima Modificare</th></tr>
        <xsl:for-each select="sitemap:sitemapindex/sitemap:sitemap">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td><xsl:value-of select="substring(sitemap:lastmod, 1, 10)"/></td>
          </tr>
        </xsl:for-each>
      </table>
    </xsl:when>
    <xsl:otherwise>
      <p>Acest sitemap contine <span class="count"><xsl:value-of select="count(sitemap:urlset/sitemap:url)"/></span> URL-uri.</p>
      <table>
        <tr><th>URL</th><th>Imagini</th><th>Ultima Modificare</th></tr>
        <xsl:for-each select="sitemap:urlset/sitemap:url">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td><xsl:value-of select="count(image:image)"/></td>
            <td><xsl:value-of select="substring(sitemap:lastmod, 1, 10)"/></td>
          </tr>
        </xsl:for-each>
      </table>
    </xsl:otherwise>
  </xsl:choose>
</body>
</html>
</xsl:template>
</xsl:stylesheet>`;

  fs.writeFileSync(path.join(DIST_DIR, 'sitemap.xsl'), xsl);
  console.log('Created: sitemap.xsl (stylesheet)');
}

// Inject images into Astro's sitemap-0.xml
function injectImagesIntoAstroSitemap() {
  const sitemapPath = path.join(DIST_DIR, 'sitemap-0.xml');
  if (!fs.existsSync(sitemapPath)) return;

  let xml = fs.readFileSync(sitemapPath, 'utf-8');

  if (!xml.includes('xmlns:image')) {
    xml = xml.replace(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    );
  }

  let injected = 0;
  xml = xml.replace(/<url><loc>(https?:\/\/[^<]+)<\/loc><\/url>/g, (match, loc) => {
    const urlPath = new URL(loc).pathname.replace(/^\/|\/$/g, '');
    if (!urlPath || urlPath.includes('/')) return match;
    const imagePath = path.join(DIST_DIR, 'images', 'articles', `${urlPath}.webp`);
    if (fs.existsSync(imagePath)) {
      injected++;
      const origin = new URL(loc).origin;
      return `<url><loc>${loc}</loc><image:image><image:loc>${origin}/images/articles/${urlPath}.webp</image:loc></image:image></url>`;
    }
    return match;
  });

  fs.writeFileSync(sitemapPath, xml, 'utf-8');
  console.log(`Injected images into sitemap-0.xml: ${injected} articles`);
}

// Main
function main() {
  console.log('Generating sitemaps for MamicaFericita.ro...\n');

  generateSitemapIndex();
  generatePostSitemap();
  generateCategorySitemap();
  generateSitemapXsl();
  injectImagesIntoAstroSitemap();

  console.log('\nDone! Sitemaps generated successfully.');
}

main();
