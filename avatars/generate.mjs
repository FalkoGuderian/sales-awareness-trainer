/**
 * Avatar-„lebende Porträts" für die 5 Bewusstseinsstufen im Sales-Awareness-Training
 * (vertrieb/sales_awareness_training.html), gleiche Pipeline wie die Premium-Sonderedition-
 * Avatare (scripts/generate-courses/gen_avatar_images.mjs + gen_avatar_videos.mjs), nur
 * lokal in diesem Ordner statt in BuchTutorLegal/avatars, weil das Trainingstool
 * eigenständig außerhalb der App/des Content-CDN lebt.
 *
 * Anders als bei den Philosophen-Avataren (echte historische Personen, daher gemeinfreie
 * Referenzbilder fuer img2img Pflicht) sind die 5 Personas hier frei erfundene, generische
 * Archetypen ohne reale Vorlage - reines Text-zu-Bild ist hier unproblematisch.
 *
 * Schritt 1: Portrait (grok-imagine-image-quality) -> <slug>-avatar.jpg
 * Schritt 2: Loop-Video daraus (grok-imagine-video, img2img) -> <slug>-avatar-animated.mp4
 *
 * Usage:
 *   node vertrieb/avatars/generate.mjs --all
 *   node vertrieb/avatars/generate.mjs --only unaware
 *   node vertrieb/avatars/generate.mjs --all --images-only   (nur Portraits, kein Video)
 * Braucht XAI_API_KEY.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolvePath(fileURLToPath(new URL(".", import.meta.url)));
const IMG_URL = "https://api.x.ai/v1/images/generations";
const IMG_MODEL = "grok-imagine-image-quality";
const VID_URL = "https://api.x.ai/v1/videos/generations";
const POLL_URL = "https://api.x.ai/v1/videos/";
const VID_MODEL = "grok-imagine-video";

const PORTRAIT_STYLE =
  "head and shoulders, near-frontal, neutral soft grey studio backdrop, Rembrandt lighting, " +
  "photorealistic, natural contemporary photo, talking-head avatar portrait, looking at camera.";

// Reihenfolge/IDs identisch zu STAGES in sales_awareness_training.html, damit die Dateinamen
// dort direkt referenziert werden koennen. Portrait-Geschlecht MUSS zur dort zugewiesenen
// Grok-TTS-Stimme passen (siehe voice-Feld je STAGES-Eintrag und die Mapping-Tabelle in
// _ttsResolveVoice() in app.html, Zeile ~27208: coral/shimmer->Eve, nova/sage->Ara = weiblich;
// echo/onyx->Rex, ash/verse->Sal, alloy->Leo = maennlich):
// unaware=Rex(m), problem_aware=Sal(m), solution_aware=Eve(w), product_aware=Leo(m), brand_aware=Ara(w).
const AVATARS = {
  unaware: "Photorealistic portrait of a relaxed man in his early twenties, casual grey hoodie, " +
    "headphones resting around his neck, mildly indifferent unbothered expression, slight easy smile, " +
    "short casual haircut. " + PORTRAIT_STYLE,
  problem_aware: "Photorealistic portrait of a stressed young man in his early twenties, tired eyes, " +
    "one hand lightly touching his forehead, simple dark sweater, visibly overwhelmed and frustrated " +
    "expression, messy printed pages blurred in the background. " + PORTRAIT_STYLE,
  solution_aware: "Photorealistic portrait of a focused, ambitious young woman in her mid-twenties, " +
    "determined thoughtful expression, index cards blurred in the background, smart casual blazer over " +
    "a plain top, confident posture. " + PORTRAIT_STYLE,
  product_aware: "Photorealistic portrait of a tech-savvy young man in his mid-twenties, skeptical " +
    "raised eyebrow, holding a smartphone at chest height, modern minimal streetwear, sharp analytical " +
    "expression. " + PORTRAIT_STYLE,
  brand_aware: "Photorealistic portrait of a warm, genuinely happy young woman in her mid-twenties, " +
    "relaxed confident smile, open laptop blurred in the background, light casual outfit, at-ease " +
    "convinced expression. " + PORTRAIT_STYLE,
};
const VIDEO_PROMPT = "Seamless looping living portrait. Start in the EXACT pose, head angle and gaze " +
  "direction of the source image. The person breathes slowly and blinks naturally. The head tilts very " +
  "gently to one side, then very gently to the other side, and then returns to the EXACT original " +
  "starting position, head angle and gaze by the final frame, so the last frame matches the first frame " +
  "(seamless loop, no jump or jerk). Subtle, natural, slow motion; a slight mouth motion as if about to " +
  "speak; static camera; photorealistic. No large, fast or abrupt movements.";

function arg(n, d = null) { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] ?? true) : d; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function genImage(slug, prompt, apiKey) {
  const body = { model: IMG_MODEL, prompt, n: 1, aspect_ratio: "3:4", response_format: "b64_json" };
  const r = await fetch(IMG_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("image HTTP " + r.status + ": " + txt.slice(0, 400));
  let j; try { j = JSON.parse(txt); } catch { throw new Error("Antwort kein JSON: " + txt.slice(0, 300)); }
  const d = (j.data || [])[0] || {};
  let bytes;
  if (d.b64_json) bytes = Buffer.from(d.b64_json, "base64");
  else if (d.url) { const ir = await fetch(d.url); bytes = Buffer.from(await ir.arrayBuffer()); }
  else throw new Error("Weder b64_json noch url in Antwort: " + JSON.stringify(j).slice(0, 300));
  await mkdir(OUT_DIR, { recursive: true });
  const out = joinPath(OUT_DIR, slug + "-avatar.jpg");
  await writeFile(out, bytes);
  console.log("  Bild OK  " + out + "  (" + (bytes.length / 1024).toFixed(0) + " KB)");
  return out;
}

async function genVideo(slug, jpgPath, apiKey) {
  const jpg = await readFile(jpgPath);
  const dataUri = "data:image/jpeg;base64," + jpg.toString("base64");
  const body = { model: VID_MODEL, prompt: VIDEO_PROMPT, image: { url: dataUri }, duration: 6, aspect_ratio: "3:4", resolution: "720p" };
  const r = await fetch(VID_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("video submit HTTP " + r.status + ": " + txt.slice(0, 400));
  const j = JSON.parse(txt);
  const id = j.request_id || j.id || (j.data && j.data[0] && (j.data[0].request_id || j.data[0].id));
  if (!id) throw new Error("keine request_id: " + txt.slice(0, 300));
  console.log("  Video-Job " + id + " -> polle...");
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const pr = await fetch(POLL_URL + id, { headers: { Authorization: "Bearer " + apiKey } });
    const pt = await pr.text();
    if (!pr.ok) { if (pr.status === 404) continue; throw new Error("poll HTTP " + pr.status + ": " + pt.slice(0, 300)); }
    let pj; try { pj = JSON.parse(pt); } catch { continue; }
    const status = pj.status || (pj.video && pj.video.status);
    const url = (pj.video && pj.video.url) || pj.url || (pj.data && pj.data[0] && pj.data[0].url);
    if (status === "done" || url) {
      if (!url) throw new Error("done aber keine url: " + pt.slice(0, 300));
      const vr = await fetch(url); const bytes = Buffer.from(await vr.arrayBuffer());
      const out = joinPath(OUT_DIR, slug + "-avatar-animated.mp4");
      await writeFile(out, bytes);
      console.log("  Video OK  " + out + "  (" + (bytes.length / 1024).toFixed(0) + " KB)");
      return;
    }
    if (status === "failed" || status === "error") throw new Error("job failed: " + pt.slice(0, 300));
    if (i % 4 === 0) console.log("    ... status=" + (status || "?") + " (" + (i * 5) + "s)");
  }
  throw new Error("Timeout beim Pollen (>300s)");
}

async function main() {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) { console.error("XAI_API_KEY not set"); process.exit(2); }
  const only = arg("--only");
  const all = arg("--all");
  const imagesOnly = !!arg("--images-only");
  if (!only && !all) { console.error("--only <slug> oder --all angeben. Slugs: " + Object.keys(AVATARS).join(", ")); process.exit(2); }
  const slugs = all ? Object.keys(AVATARS) : [String(only)];
  for (const slug of slugs) {
    if (!AVATARS[slug]) { console.error("unbekannter slug: " + slug); continue; }
    console.log(slug + ":");
    try {
      const jpgPath = await genImage(slug, AVATARS[slug], apiKey);
      if (!imagesOnly) await genVideo(slug, jpgPath, apiKey);
    } catch (e) { console.error("  FEHLER " + slug + ": " + e.message); }
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
