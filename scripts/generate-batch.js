import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Load .env for standalone usage
try {
  const envContent = fs.readFileSync(path.join(rootDir, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0 && !process.env[key.trim()]) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }
} catch (e) {}

// API Keys
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || '').split(',').filter(Boolean);

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

let currentKeyIndex = 0;

function getNextGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeForHtml(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;');
}

function stripStrong(str) {
  return str.replace(/<\/?strong>/g, '');
}

function stripFakeLinks(html, pagesDir) {
  return html.replace(/<a\s+href="\/([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (match, linkPath, text) => {
    const slug = linkPath.replace(/\/$/, '');
    if (fs.existsSync(path.join(pagesDir, `${slug}.astro`))) return match;
    if (fs.existsSync(path.join(pagesDir, slug))) return match;
    return text;
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Translate title to English using Gemini
async function translateToEnglish(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Translate the following Romanian text to English. Return ONLY the English translation, nothing else:\n\n${text}` }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 200 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }
      console.error(`  Translation attempt ${attempt + 1} failed: no candidates`);
    } catch (error) {
      console.error(`  Translation attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  return text;
}

// Generate image using Cloudflare Workers AI

// Strip brand names from image prompt to avoid Cloudflare AI content filter
function stripBrands(text) {
  return text
    .replace(/\b[A-Z][a-z]+[A-Z]\w*/g, '')  // camelCase brands: HyperX, PlayStation
    .replace(/\b[A-Z]{2,}\b/g, '')            // ALL CAPS: ASUS, RGB, LED
    .replace(/\s{2,}/g, ' ')                   // collapse double spaces
    .trim();
}

// Use Gemini to rephrase a title into a generic description without brand names
async function rephraseWithoutBrands(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Rephrase the following into a short, generic English description for an image prompt. Remove ALL brand names, trademarks, product names, and game names. Replace them with generic descriptions of what they are. Return ONLY the rephrased text, nothing else.\n\nExample: "Boggle classic word game" -> "classic letter dice word game on a table"\nExample: "Kindle Paperwhite review" -> "slim e-reader device with paper-like screen"\nExample: "Duolingo app for learning languages" -> "colorful language learning mobile app interface"\n\nText: "${text}"` }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 100 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const result = data.candidates[0].content.parts[0].text.trim();
        console.log(`  Rephrased prompt (no brands): ${result}`);
        return result;
      }
    } catch (error) {
      console.error(`  Rephrase attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  // Fallback to basic stripBrands
  return stripBrands(text);
}

async function generateSafePrompt(text, categorySlug) {
  const categoryFallbacks = {
    'carucioare-accesorii-bebe': 'a modern stroller and accessories arranged in a bright nursery, soft warm lighting, pastel colors',
    'jucarii-educative': 'colorful educational wooden toys and building blocks on a playroom shelf, cheerful bright atmosphere',
    'alimentatie-nutritie-copii': 'healthy colorful food plates and bowls arranged on a bright modern kitchen table, natural lighting',
    'produse-mamici': 'cozy self-care products and soft blankets in a modern bedroom, warm relaxing atmosphere',
    'camera-copilului': 'beautifully decorated nursery room with soft pastel furniture and plush toys, cozy whimsical atmosphere',
  };
  // Try Gemini to create a safe, abstract prompt
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Create a short, safe English image prompt for a stock photo related to this topic: "${text}". The prompt must describe ONLY objects, scenery, and atmosphere. NEVER mention people, children, babies, faces, hands, or any human body parts. NEVER use brand names. Focus on products, objects, books, devices, furniture, toys, or abstract scenes. Return ONLY the description, nothing else.\n\nExample: "baby stroller review" -> "modern stroller parked in a sunny garden with flowers"\nExample: "children board game" -> "colorful board game pieces and dice on a wooden table"\nExample: "interactive book for babies" -> "colorful pop-up book open on a soft blanket with plush toys around"` }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 100 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const result = data.candidates[0].content.parts[0].text.trim();
        console.log(`  Safe prompt generated: ${result}`);
        return result;
      }
    } catch (error) {
      console.error(`  Safe prompt attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  return categoryFallbacks[categorySlug] || 'beautiful arrangement of colorful products on a clean modern table, warm ambient lighting, cozy home atmosphere';
}

async function generateImage(titleRo, slug, categorySlug) {
  const categoryPrompts = {
    'carucioare-accesorii-bebe': 'in a bright and cheerful nursery, soft warm lighting, pastel colors, safe family atmosphere',
    'jucarii-educative': 'in a colorful bright playroom, cheerful atmosphere, soft warm lighting, child-friendly setting',
    'alimentatie-nutritie-copii': 'in a bright modern kitchen, cheerful family atmosphere, soft natural lighting, clean and safe',
    'produse-mamici': 'in a cozy modern bedroom or living room, soft warm lighting, relaxing maternal atmosphere',
    'camera-copilului': 'in a beautifully decorated nursery or kids room, soft pastel lighting, cozy and whimsical atmosphere',
  };

  console.log(`  Generating image for: ${titleRo}`);

  const MAX_IMAGE_RETRIES = 4;
  let promptFlagged = false;

  for (let attempt = 1; attempt <= MAX_IMAGE_RETRIES; attempt++) {

    if (attempt > 1) {

      console.log(`  Image retry attempt ${attempt}/${MAX_IMAGE_RETRIES}...`);

      await new Promise(r => setTimeout(r, 3000 * attempt));

    }


  try {
    let prompt;

    if (attempt >= 3) {
      // Last resorts: use fully safe prompt with no reference to original subject
      const safeSubject = await generateSafePrompt(titleRo, categorySlug);
      prompt = `Realistic photograph of ${safeSubject}, no text, no writing, no words, no letters, no numbers. Photorealistic, high quality, professional photography.`;
    } else {
      const titleEn = await translateToEnglish(titleRo);
      console.log(`  Translated title: ${titleEn}`);

      const setting = categoryPrompts[categorySlug] || 'in a modern home setting, soft natural lighting, clean contemporary background';
      const subject = promptFlagged ? await rephraseWithoutBrands(titleEn) : titleEn;
      prompt = `Realistic photograph of ${subject} ${setting}, no text, no brand name, no writing, no words, no letters, no numbers. Photorealistic, high quality, professional product photography.`;
    }

    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('steps', '20');
    formData.append('width', '1024');
    formData.append('height', '768');

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-dev`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  Image API error: ${response.status} - ${errorText.slice(0, 200)}`);
      if (errorText.includes('flagged')) promptFlagged = true;
      continue;
    }

    const data = await response.json();
    if (!data.result?.image) {
      console.error('  No image in response');
      continue;
    }

    const imageBuffer = Buffer.from(data.result.image, 'base64');

    const outputPath = path.join(rootDir, 'public', 'images', 'articles', `${slug}.webp`);
    await sharp(imageBuffer)
      .resize(800, 600, { fit: 'cover' })
      .webp({ quality: 82, effort: 6 })
      .toFile(outputPath);

    console.log(`  Image saved: ${outputPath}`);
    return `/images/articles/${slug}.webp`;
  } catch (error) {
    console.error(`  Image generation error: ${error.message}`);
    continue;
  }


  }

  console.error('  Image generation failed after all retries');

  return null;
}

// Generate article content using Gemini
async function generateArticleContent(keyword, category, completedArticles = []) {

  
  // Build interlink list from completed articles
  const currentSlug = keyword.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const interlinkCandidates = completedArticles
    .filter(a => a.keyword !== keyword)
    .map(a => {
      const aSlug = a.keyword.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return { title: a.keyword.charAt(0).toUpperCase() + a.keyword.slice(1), slug: aSlug, category: a.category, categorySlug: a.categorySlug };
    });
  // Prioritize same category, then others, max 15
  const sameCategory = interlinkCandidates.filter(a => a.categorySlug === completedArticles.find(c => c.keyword === keyword)?.categorySlug);
  const otherCategory = interlinkCandidates.filter(a => !sameCategory.includes(a));
  const interlinkList = [...sameCategory, ...otherCategory].slice(0, 15)
    .map(a => `- <a href="/${a.slug}/">${a.title}</a> (categorie: ${a.category})`)
    .join('\n');

const prompt = `Scrii articole pe un site romanesc despre produse pentru copii, bebelusi si mamici. Stilul e informativ dar directionat spre conversie - ajuti cititorul sa ia o decizie de cumparare. NU esti un AI.

Keyword: "${keyword}"
Categorie: "${category}"

GENEREAZA un articol complet in format JSON. Fara diacritice. Minim 2000 cuvinte.

=== TONUL SI STILUL (CRITIC) ===
Tonul e informativ-conversional, NU personal/jurnal. Scopul e sa raspunzi la intentia de cautare si sa ghidezi spre cumparare.

INTRO:
- Primul paragraf RASPUNDE DIRECT la intentia din keyword. Daca cineva cauta "${keyword}", ce vrea sa afle? Raspunde-i imediat.
- Nu incepe cu anecdote, nu incepe cu "tu" sau "daca vrei". Incepe cu RASPUNSUL.

REVIEW-URI PRODUSE:
- Ton obiectiv dar accesibil - ca un review pe un site de specialitate, nu ca o poveste personala
- Translatezi specs in beneficii practice: "greutatea de 2kg inseamna ca il poti cara usor in geanta"
- Compari cu alternative directe
- Preturi concrete in lei
- Review-ul include pentru cine e potrivit si se incheie cu o recomandare clara
- Maximum 1-2 referinte personale ("am testat") in tot articolul
- Tonul e de expert care informeaza, nu de prietena care povesteste

CONVERSIE:
- Ghideaza spre decizie: "daca prioritizezi siguranta, alege X; daca vrei raport calitate-pret, alege Y"
- Mentioneaza pretul si unde se gaseste
- Concluzia fiecarui review sa fie actionabila

=== ANTI-AI ===
- CUVINTE INTERZISE: "Asadar", "De asemenea", "Cu toate acestea", "Este important de mentionat", "Nu in ultimul rand", "in era actuala", "descopera", "fara indoiala", "in concluzie", "este esential", "este crucial", "o alegere excelenta", "ghid", "ghiduri", "exploreaza", "aprofundam", "remarcabil", "exceptional", "revolutionar", "inovativ", "vom detalia", "vom analiza", "vom explora", "vom prezenta", "in cele ce urmeaza", "in continuare vom", "sa aruncam o privire", "buget optimizat", "alegerea editorului", "editor's choice"
- TAG-URI INTERZISE IN PRODUSE: "Buget Optimizat", "Alegerea Editorului" - suna a cliseu. Foloseste: "Alegerea Noastra", "Pentru Buget Mic", "Best Buy 2026", "Raport Calitate-Pret", "Premium"
- Amesteca paragrafe scurte (1-2 prop) cu medii (3-4 prop)
- Critici oneste: fiecare produs minim 3-4 dezavantaje reale
- Limbaj natural dar nu excesiv informal

=== PARAGRAFE CU INTREBARI (IMPORTANT PENTRU AI SEARCH) ===
Multe paragrafe trebuie sa inceapa cu o INTREBARE directa urmata de raspuns. Asta permite AI-ului (Google AI Overview, ChatGPT, Perplexity) sa citeze textul tau.
- In intro: minim 1 paragraf care incepe cu intrebare
- In review-urile de produse: minim 1 paragraf per review care incepe cu intrebare
- In sectiunea de sfaturi: fiecare h4 sa fie intrebare, iar paragraful de sub el sa inceapa cu raspunsul direct
- Exemplu bun: "Este sigur pentru nou-nascuti? Da, modelul X are certificare EN 1888 si sistem de prindere in 5 puncte, ceea ce il face potrivit de la nastere."

=== STRUCTURA JSON ===

IMPORTANT: Returneaza DOAR JSON valid. Fara markdown, fara backticks.
In valorile string din JSON, foloseste \\n pentru newline si escaped quotes \\".

{
  "intro": "2-3 paragrafe HTML (<p>). PRIMUL PARAGRAF raspunde direct la intentia de cautare - ce produs e cel mai bun si de ce, cu date concrete. Din el se extrage automat descrierea.",
  "items": [
    {
      "name": "Numele complet al produsului",
      "tag": "Best Buy 2026",
      "specs": {
        "varsta_recomandata": "ex: 0-36 luni",
        "material": "ex: bumbac organic certificat GOTS",
        "dimensiuni": "ex: 120x60 cm",
        "greutate": "ex: 8.5 kg",
        "siguranta": "ex: certificare EN 716, fara BPA"
      },
      "review": "4-6 paragrafe HTML (<p>). Review obiectiv: ce face bine, ce face prost, comparat cu ce, pentru cine, la ce pret. Ultimul paragraf = recomandare actionabila.",
      "avantaje": ["avantaj 1", "avantaj 2", "avantaj 3", "avantaj 4"],
      "dezavantaje": ["dezavantaj 1", "dezavantaj 2", "dezavantaj 3"]
    }
  ],
  "comparison": {
    "intro": "1 paragraf introductiv pentru tabelul comparativ",
    "rows": [
      {
        "model": "Numele modelului",
        "varsta": "interval varsta",
        "material": "scurt",
        "greutate": "kg",
        "siguranta": "certificari",
        "potrivitPentru": "scurt, 3-5 cuvinte"
      }
    ]
  },
  "guide": {
    "title": "Titlu ca intrebare (ex: Cum alegi cel mai bun carucior pentru bebelusul tau?)",
    "content": "3-5 paragrafe HTML (<p>, <h4>, <p>) cu sfaturi de cumparare orientate spre decizie. Sub-intrebari ca <h4>. Fiecare sfat directioneaza spre un tip de produs."
  },
  "faq": [
    {
      "question": "Intrebare naturala de cautare Google",
      "answer": "Raspuns direct 40-70 cuvinte cu cifre concrete."
    }
  ]
}

=== CERINTE PRODUSE ===
- 5-7 produse relevante pentru "${keyword}", ordonate dupa relevanta
- Specs REALE si CORECTE
- Preturi realiste in lei, Romania 2026
- Review minim 200 cuvinte per produs
- Avantaje: 4-6 | Dezavantaje: 3-5 (oneste, nu cosmetice)
- Tag-uri: "Best Buy 2026", "Raport Calitate-Pret", "Premium", "Pentru Buget Mic", "Alegerea Noastra"

=== CERINTE FAQ ===
- 5 intrebari formulari naturale: "cat costa...", "care e diferenta intre...", "merita sa..."
- Raspunsuri cu cifre concrete, auto-suficiente, fara diacritice

=== REGULI ===
- FARA diacritice (fara ă, î, ș, ț, â)
- Preturile in LEI, realiste
- Keyword "${keyword}" in <strong> de 4-6 ori in articol
- NICIODATA <strong> in titluri/headings
- Total minim 2000 cuvinte

\${interlinkList.length > 0 ? \`
=== INTERLINK-URI INTERNE (SEO) ===
Mentioneaza NATURAL in text 2-4 articole de pe site, cu link-uri <a href="/{slug}/">{titlu}</a>.
Integreaza in propozitii, NU ca lista separata. Max 4 link-uri. Doar unde are sens contextual.
NU forta link-uri daca nu au legatura cu subiectul.

Articole disponibile:
\${interlinkList}\` : ''}`;

  let retries = 5;
  while (retries > 0) {
    const apiKey = getNextGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 40000,
            responseMimeType: "application/json"
          }
        })
      });

      const data = await response.json();

      if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        let text = data.candidates[0].content.parts[0].text.trim();

        try {
          const parsed = JSON.parse(text);
          if (parsed.intro && parsed.items && parsed.faq) {
            return parsed;
          }
          console.error('  Invalid JSON structure, retrying...');
          retries--;
          await sleep(2000);
        } catch (parseError) {
          console.error(`  JSON parse error: ${parseError.message.substring(0, 50)}, retrying...`);
          retries--;
          await sleep(2000);
        }
      } else {
        console.error('  No content in response');
        retries--;
        await sleep(2000);
      }
    } catch (error) {
      console.error(`  API error: ${error.message}`);
      retries--;
      await sleep(2000);
    }
  }

  throw new Error('Failed to generate content after retries');
}

// Convert markdown to HTML
function markdownToHtml(text) {
  if (!text) return text;
  // Convert **bold** to <strong>
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Remove markdown list markers (* or - at start of line)
  text = text.replace(/^\*\s+/gm, '');
  text = text.replace(/^-\s+/gm, '');
  text = text.replace(/\n\*\s+/g, '\n');
  text = text.replace(/\n-\s+/g, '\n');
  return text;
}

// Create article page
function createArticlePage(keyword, content, imagePath, category, categorySlug, author) {
  const slug = slugify(keyword);
  const title = capitalizeFirst(keyword);
  const date = new Date().toISOString();

  // Clean HTML content
  function cleanHtml(text) {
    if (!text) return '';
    text = markdownToHtml(text);
    if (!text.includes('<p>') && !text.includes('<h')) {
      text = text.split(/\n\n+/).filter(p => p.trim()).map(p => `<p>${p.trim()}</p>`).join('\n');
    }
    return text;
  }

  // Process intro and extract excerpt from first paragraph
  const introHtml = cleanHtml(content.intro || '');
  const firstPMatch = introHtml.match(/<p>([\s\S]*?)<\/p>/);
  let excerpt = firstPMatch ? firstPMatch[1].replace(/<[^>]*>/g, '').replace(/\*\*/g, '') : '';
  if (excerpt.length > 300) {
    const sentences = excerpt.match(/[^.!?]+[.!?]+/g) || [excerpt];
    excerpt = sentences.slice(0, 2).join('').trim();
  }

  // Generate product review HTML blocks
  const productReviewsHtml = (content.items || []).map((product, idx) => {
    const productId = slugify(product.name);
    const specs = product.specs || {};
    const specsGrid = Object.entries(specs).map(([key, val]) =>
      `              <div class="product-review__spec">
                <strong>${capitalizeFirst(key.replace(/_/g, ' '))}</strong>${val}
              </div>`
    ).join('\n');

    const reviewContent = cleanHtml(product.review || '');

    const avantajeHtml = (product.avantaje || []).map(a =>
      `              <li>${markdownToHtml(a)}</li>`
    ).join('\n');

    const dezavantajeHtml = (product.dezavantaje || []).map(d =>
      `              <li>${markdownToHtml(d)}</li>`
    ).join('\n');

    const tag = product.tag || '';

    return `
          <article class="product-review" id="${productId}">
            <div class="product-review__header">
              ${tag ? `<span class="section-tag">${tag}</span>` : ''}
              <h3>${product.name}</h3>
              <div class="product-review__specs-grid">
${specsGrid}
              </div>
            </div>
            <div class="product-review__content">
              ${reviewContent}

              <div class="product-review__lists">
                <div>
                  <h4>Avantaje</h4>
                  <ul class="product-review__pros">
${avantajeHtml}
                  </ul>
                </div>
                <div>
                  <h4>Dezavantaje</h4>
                  <ul class="product-review__cons">
${dezavantajeHtml}
                  </ul>
                </div>
              </div>
            </div>
          </article>`;
  }).join('\n');

  // Generate comparison table HTML
  let comparisonHtml = '';
  if (content.comparison && content.comparison.rows && content.comparison.rows.length > 0) {
    const compIntro = cleanHtml(content.comparison.intro || '');
    const firstRow = content.comparison.rows[0];
    const colKeys = Object.keys(firstRow).filter(k => k !== 'model' && k !== 'name');
    const headerCells = colKeys.map(k => `<th>${capitalizeFirst(k.replace(/_/g, ' '))}</th>`).join('\n                      ');

    const compRows = content.comparison.rows.map(row => {
      const cells = colKeys.map(k => `<td>${row[k] || ''}</td>`).join('\n                ');
      return `
              <tr>
                <td><strong>${row.model || row.name || ''}</strong></td>
                ${cells}
              </tr>`;
    }).join('\n');

    comparisonHtml = `
          <section id="comparatie">
            <h2>Comparatie</h2>
            ${compIntro}
            <div class="comparison-outer">
              <div class="comparison-hint">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                Gliseaza pentru a vedea tot tabelul
              </div>
              <div class="comparison-wrap">
                <table class="comparison-table">
                  <thead>
                    <tr>
                      <th>Produs</th>
                      ${headerCells}
                    </tr>
                  </thead>
                  <tbody>
${compRows}
                  </tbody>
                </table>
              </div>
            </div>
          </section>`;
  }

  // Generate guide HTML
  let guideHtml = '';
  if (content.guide) {
    const guideTitle = content.guide.title || 'Ghid de cumparare';
    const guideContent = cleanHtml(content.guide.content || '');
    guideHtml = `
          <section id="ghid">
            <h2>${stripStrong(guideTitle)}</h2>
            <div class="guide">
              ${guideContent}
            </div>
          </section>`;
  }

  // Generate FAQ HTML
  const faqHtml = (content.faq || []).map((item, index) => `
            <div class="faq-item" id="faq-${index}">
              <button class="faq-question" onclick="this.parentElement.classList.toggle('open')">
                ${stripStrong(markdownToHtml(item.question))}
                <span class="faq-icon">+</span>
              </button>
              <div class="faq-answer">
                ${stripStrong(markdownToHtml(item.answer))}
              </div>
            </div>`).join('\n');

  const faqArray = (content.faq || []).map(item =>
    `{ question: "${stripStrong(item.question).replace(/"/g, '\\"')}", answer: "${stripStrong(item.answer).replace(/"/g, '\\"').replace(/\n/g, ' ')}" }`
  );

  // Build TOC from items + comparison + guide + FAQ
  const tocEntries = [];
  (content.items || []).forEach(p => {
    tocEntries.push({ title: p.name, id: slugify(p.name) });
  });
  if (comparisonHtml) tocEntries.push({ title: 'Comparatie', id: 'comparatie' });
  if (guideHtml) tocEntries.push({ title: content.guide?.title || 'Ghid de cumparare', id: 'ghid' });
  tocEntries.push({ title: 'Intrebari Frecvente', id: 'faq' });

  const tocItems = tocEntries.map(t =>
    `{ title: "${t.title.replace(/"/g, '\\"')}", id: "${t.id}" }`
  );

  const pubDateDisplay = new Date(date).toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' });

  let pageContent = `---
import Layout from '../layouts/Layout.astro';
import SimilarArticles from '../components/SimilarArticles.astro';
import PrevNextNav from '../components/PrevNextNav.astro';
import keywordsData from '../../keywords.json';

export const frontmatter = {
  title: "${title}",
  excerpt: "${excerpt.replace(/"/g, '\\"')}",
  image: "${imagePath || '/images/articles/default.webp'}",
  category: "${category}",
  categorySlug: "${categorySlug}",
  date: "${date}",
  modifiedDate: "${date}",
  author: "${author.name}",
  authorRole: "${author.role}",
  authorBio: "${author.bio.replace(/"/g, '\\"')}"
};

const faq = [
  ${faqArray.join(',\n  ')}
];

const toc = [
  ${tocItems.join(',\n  ')}
];

// Get all articles for similar articles component
const allArticles = keywordsData.completed.map(item => ({
  title: item.keyword.charAt(0).toUpperCase() + item.keyword.slice(1),
  slug: item.keyword.toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
  excerpt: item.excerpt || '',
  image: \`/images/articles/\${item.keyword.toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.webp\`,
  category: item.category,
  categorySlug: item.categorySlug,
  date: item.date || new Date().toISOString()
}));
---

<Layout
  title="${escapeForHtml(title)} - MamicaFericita"
  description="${escapeForHtml(excerpt)}"
  image="${imagePath || '/images/articles/default.webp'}"
  type="article"
  publishedTime="${date}"
  modifiedTime="${date}"
  author="${escapeForHtml(author.name)}"
  faq={faq}
>
  <article class="article-page">
    <a href="/${categorySlug}/" class="article-page-category">${category}</a>
    <h1 class="article-page-title">${title}</h1>

    <div class="article-page-meta">
      <span>${author.name}</span>
      <span>&middot;</span>
      <span>${pubDateDisplay}</span>
    </div>

    ${imagePath ? `<img src="${imagePath}" alt="${escapeForHtml(title)}" class="article-page-image" width="800" height="600" loading="eager">` : ''}

    <div class="article-layout">
      <aside class="toc-sidebar">
        <p class="toc-sidebar-title">Cuprins</p>
        <ol class="toc-sidebar-list" id="toc-desktop-list">
          {toc.map(item => (
            <li><a href={\`#\${item.id}\`} data-toc-id={item.id}>{item.title}</a></li>
          ))}
        </ol>
      </aside>

      <div>
        <div class="toc-mobile" id="toc-mobile">
          <button class="toc-mobile-toggle" onclick="this.parentElement.classList.toggle('open')">
            Cuprins
            <span class="toc-chevron">&#9660;</span>
          </button>
          <ol class="toc-mobile-list">
            {toc.map(item => (
              <li><a href={\`#\${item.id}\`}>{item.title}</a></li>
            ))}
          </ol>
        </div>

        <div class="article-content">
          <section id="intro">
            ${introHtml}
          </section>

${productReviewsHtml}

${comparisonHtml}

${guideHtml}

          <section class="faq-section" id="faq">
            <h2 class="faq-title">Intrebari Frecvente</h2>
            ${faqHtml}
          </section>
        </div>

        <div class="author-line">
          <div class="author-avatar">${author.name.split(' ').map(n => n[0]).join('')}</div>
          <div>
            <div class="author-name">${author.name}</div>
            <div class="author-role">${author.role}</div>
          </div>
        </div>

        <SimilarArticles
          currentSlug="${slug}"
          currentCategory="${categorySlug}"
          articles={allArticles}
        />

        <PrevNextNav
          currentSlug="${slug}"
          currentCategory="${categorySlug}"
          articles={allArticles}
        />
      </div>
    </div>
  </article>

  <script>
    document.querySelectorAll('.comparison-outer').forEach(outer => {
      const wrap = outer.querySelector('.comparison-wrap');
      if (!wrap) return;
      function checkScroll() {
        const canScroll = wrap.scrollWidth > wrap.clientWidth;
        const atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
        outer.classList.toggle('can-scroll', canScroll && !atEnd);
      }
      checkScroll();
      wrap.addEventListener('scroll', checkScroll, { passive: true });
      window.addEventListener('resize', checkScroll, { passive: true });
    });

    const tocLinks = document.querySelectorAll('#toc-desktop-list a[data-toc-id]');
    if (tocLinks.length > 0) {
      const ids = Array.from(tocLinks).map(a => a.dataset.tocId);
      const sections = ids.map(id => document.getElementById(id)).filter(Boolean);
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              tocLinks.forEach(a => a.classList.remove('active'));
              const match = Array.from(tocLinks).find(a => a.dataset.tocId === entry.target.id);
              match?.classList.add('active');
            }
          }
        },
        { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
      );
      sections.forEach(s => observer.observe(s));
    }
  </script>
</Layout>
`;

  const outputPath = path.join(rootDir, 'src', 'pages', `${slug}.astro`);
  pageContent = stripFakeLinks(pageContent, path.join(rootDir, 'src', 'pages'));
  fs.writeFileSync(outputPath, pageContent);
  console.log(`  Article page created: ${outputPath}`);

  return {
    slug,
    title,
    excerpt,
    date
  };
}


// Main execution
async function main() {
  console.log('\n========================================');
  console.log('MamicaFericita.ro - Article Generator');
  console.log('========================================\n');

  // Read keywords
  const keywordsPath = path.join(rootDir, 'keywords.json');
  const keywordsData = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));

  // Check for temp-articles.json (created by auto-generate.js)
  const tempArticlesPath = path.join(rootDir, 'temp-articles.json');
  let pending;

  if (fs.existsSync(tempArticlesPath)) {
    // Use temp-articles.json if it exists (from auto-generate.js)
    const tempData = JSON.parse(fs.readFileSync(tempArticlesPath, 'utf-8'));
    pending = Array.isArray(tempData) ? tempData : (tempData.articles || []);
    console.log(`Using temp-articles.json: ${pending.length} article(s) to generate`);
  } else {
    // Fallback to all pending keywords
    pending = keywordsData.pending;
    console.log(`Using keywords.json: ${pending.length} pending keywords`);
  }

  if (pending.length === 0) {
    console.log('No pending keywords to process.');
    return;
  }

  // Ensure images directory exists
  const imagesDir = path.join(rootDir, 'public', 'images', 'articles');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const successfulKeywords = [];

  for (const item of pending) {
    console.log(`\nProcessing: ${item.keyword}`);
    console.log(`Category: ${item.category}`);

    try {
      // Find author for this category
      const author = keywordsData.authors.find(a => a.categories.includes(item.categorySlug))
        || keywordsData.authors[0];

      // Generate content
      console.log('  Generating content...');
      const content = await generateArticleContent(item.keyword, item.category, keywordsData?.completed || []);
      console.log('  Content generated successfully');

      // Generate image
      const slug = slugify(item.keyword);
      const imagePath = await generateImage(item.keyword, slug, item.categorySlug);

      // Create article page
      const articleData = createArticlePage(
        item.keyword,
        content,
        imagePath,
        item.category,
        item.categorySlug,
        author
      );

      // Add to successful
      successfulKeywords.push({
        ...item,
        excerpt: articleData.excerpt,
        date: articleData.date
      });

      console.log(`  Completed: ${item.keyword}`);

      // Small delay between articles
      await sleep(1000);

    } catch (error) {
      console.error(`  Failed: ${item.keyword} - ${error.message}`);
    }
  }

  // Write successful-keywords.json for auto-generate.js (full objects with excerpt and date)
  const successfulKeywordsPath = path.join(rootDir, 'successful-keywords.json');
  fs.writeFileSync(successfulKeywordsPath, JSON.stringify(successfulKeywords, null, 2));

  // DON'T update keywords.json here - auto-generate.js handles that
  // Only update if NOT using temp-articles.json (standalone mode)
  if (!fs.existsSync(tempArticlesPath) && successfulKeywords.length > 0) {
    const successfulSet = new Set(successfulKeywords.map(k => k.keyword));
    keywordsData.pending = keywordsData.pending.filter(k => !successfulSet.has(k.keyword));
    keywordsData.completed = [...keywordsData.completed, ...successfulKeywords];

    fs.writeFileSync(keywordsPath, JSON.stringify(keywordsData, null, 2));
    console.log(`\nUpdated keywords.json: ${successfulKeywords.length} articles completed`);
  }

  console.log('\n========================================');
  console.log(`Total processed: ${successfulKeywords.length}/${pending.length}`);
  console.log('========================================\n');
}

main().catch(console.error);
