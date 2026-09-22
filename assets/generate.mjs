/**
 * Erzeugt cover.png (Social-Preview/README-Banner) und die drei mobilen
 * Quickstart-Screenshots (screenshot-start/-chat/-result.png) neu.
 *
 * Faehrt eine lokale, bereits laufende Chrome-Instanz per DevTools-Protocol (CDP) fern -
 * keine npm-Abhaengigkeiten (playwright/puppeteer) noetig, nur Node >=18 (natives
 * fetch + WebSocket) und ein installiertes Chrome/Chromium.
 *
 * WICHTIG: index.html kapselt seinen gesamten Code in einer IIFE ("use strict").
 * Die dort definierten Funktionen (showPanel, addBubble, showResult, ...) sind daher
 * NICHT global aufrufbar - Runtime.evaluate("applyActivePanel(...)") schlaegt mit
 * "ReferenceError: applyActivePanel is not defined" fehl, obwohl das Skript laeuft.
 * Deshalb wird der App-Zustand hier bewusst per direkter DOM-Manipulation (classList,
 * innerHTML, createElement) nachgebaut statt interne Funktionen aufzurufen.
 *
 * Usage:
 *   1. Chrome headless mit Remote-Debugging-Port starten, z.B.:
 *      chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp-dir>
 *   2. node assets/generate.mjs
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

const CDP = "http://localhost:9333";
const DIR = resolvePath(fileURLToPath(new URL(".", import.meta.url)));
const APP_URL = "file:///" + joinPath(DIR, "..", "index.html").replace(/\\/g, "/");

async function newTab(url) {
  const r = await fetch(CDP + "/json/new?" + encodeURIComponent(url), { method: "PUT" });
  return r.json();
}
async function closeTab(id) { await fetch(CDP + "/json/close/" + id); }
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
}
function cdpClient(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) { for (const l of listeners) l(msg.method, msg.params); }
  });
  function send(method, params = {}) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  function once(method) {
    return new Promise((resolve) => { const fn = (m, p) => { if (m === method) resolve(p); }; listeners.push(fn); });
  }
  return { send, once };
}
async function evalJs(c, expression) {
  const res = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(res.exceptionDetails));
  return res.result;
}
async function withTab(url, fn) {
  const tab = await newTab(url);
  const ws = await connect(tab.webSocketDebuggerUrl);
  const c = cdpClient(ws);
  try { return await fn(c); }
  finally { ws.close(); await closeTab(tab.id); }
}

/* ---------------- Cover (1200x630, Social-Preview + README-Banner) ---------------- */

async function renderCover(srcHtml, outFile) {
  const coverUrl = "file:///" + joinPath(DIR, srcHtml).replace(/\\/g, "/");
  await withTab("about:blank", async (c) => {
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 2, mobile: false });
    const nav = c.send("Page.navigate", { url: coverUrl });
    await c.once("Page.loadEventFired");
    await nav;
    await new Promise((r) => setTimeout(r, 100));
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    await writeFile(outFile, Buffer.from(data, "base64"));
    console.log("written:", outFile);
  });
}

/* ---------------- Mobile-Screenshots (echte App, DOM-Zustand nachgebaut) ---------------- */

const W = 390, H = 844, DSR = 3;

const hideScrollbarJs = `
  (function(){
    var s = document.createElement('style');
    s.textContent = 'html::-webkit-scrollbar{display:none} html{scrollbar-width:none}';
    document.head.appendChild(s);
  })();
`;
const setActivePanel = (name) => `
  Array.prototype.forEach.call(document.querySelectorAll('.panel'), function(p){ p.classList.toggle('active', p.dataset.panel === '${name}'); });
  Array.prototype.forEach.call(document.querySelectorAll('.side-menu-item'), function(b){ b.classList.toggle('active', b.dataset.panel === '${name}'); });
`;
// Klickt den echten Sprachumschalter statt setLang() (IIFE-privat) direkt aufzurufen -
// ein echtes .click() loest den intern registrierten Listener aus und uebersetzt die
// gesamte UI (STAGES-Inhalte, statische Labels) korrekt ueber die App-eigene i18n-Logik.
// Noetig auch fuer DE: die Sprachpraeferenz liegt in localStorage und ist ueber alle
// Navigationen zur gleichen file://-Origin hinweg persistent, ein vorheriger EN-Shot
// wuerde sonst in nachfolgenden "DE"-Shots stehen bleiben.
const clickEnJs = `document.querySelector('.lang-switch button[data-lang="en"]').click();`;
const clickDeJs = `document.querySelector('.lang-switch button[data-lang="de"]').click();`;
function addBubbleJs(role, text, lang) {
  const label = lang === "en" ? (role === "seller" ? "You" : "Prospect") : (role === "seller" ? "Du" : "Interessent");
  return `(function(){
    var wrap = document.createElement('div'); wrap.className = 'bubble-wrap ${role}';
    var label = document.createElement('div'); label.className = 'bubble-label';
    label.textContent = ${JSON.stringify(label)};
    var bubble = document.createElement('div'); bubble.className = 'bubble ${role}';
    bubble.textContent = ${JSON.stringify(text)};
    wrap.appendChild(label); wrap.appendChild(bubble);
    document.getElementById('log').appendChild(wrap);
  })();`;
}
function verdictCardJs(kind, title, text) {
  const iconChar = kind === "ok" ? "✓" : kind === "bad" ? "✕" : "!";
  return `(function(){
    var div = document.createElement('div'); div.className = 'verdict-card ${kind}';
    var icon = document.createElement('div'); icon.className='icon'; icon.textContent = ${JSON.stringify(iconChar)};
    var t = document.createElement('div'); t.className='t';
    var b = document.createElement('b'); b.textContent = ${JSON.stringify(title)};
    t.appendChild(b); t.appendChild(document.createTextNode(${JSON.stringify(text)}));
    div.appendChild(icon); div.appendChild(t);
    document.getElementById('verdict-list').appendChild(div);
  })();`;
}
function fillListJs(id, items) {
  return `(function(){
    var ul = document.getElementById(${JSON.stringify(id)});
    ${items.map((txt) => `(function(){ var li=document.createElement('li'); li.textContent=${JSON.stringify(txt)}; ul.appendChild(li); })();`).join("\n")}
  })();`;
}

async function shot(outFile, setupJs) {
  await withTab("about:blank", async (c) => {
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    const nav = c.send("Page.navigate", { url: APP_URL });
    await c.once("Page.loadEventFired");
    await nav;
    await new Promise((r) => setTimeout(r, 300));
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSR, mobile: false });
    if (setupJs) await evalJs(c, setupJs);
    await new Promise((r) => setTimeout(r, 150));
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    await writeFile(outFile, Buffer.from(data, "base64"));
    console.log("written:", outFile);
  });
}

async function frame(srcFile, outFile) {
  const frameUrl = "file:///" + joinPath(DIR, "phone-frame-src.html").replace(/\\/g, "/");
  await withTab("about:blank", async (c) => {
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 460, height: 960, deviceScaleFactor: 2, mobile: false });
    const nav = c.send("Page.navigate", { url: frameUrl });
    await c.once("Page.loadEventFired");
    await nav;
    await evalJs(c, `(function(){ return new Promise(function(resolve){
      var img = document.getElementById('shot'); img.onload = function(){ resolve(true); }; img.src = ${JSON.stringify(srcFile)};
    }); })();`);
    await new Promise((r) => setTimeout(r, 100));
    const rect = (await evalJs(c, `(function(){ var r = document.querySelector('.phone').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })();`)).value;
    const { data } = await c.send("Page.captureScreenshot", {
      format: "png", omitBackground: true,
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    });
    await writeFile(outFile, Buffer.from(data, "base64"));
    console.log("written:", outFile);
  });
}

async function generateChat(outFile, lang) {
  const l = {
    de: {
      click: clickDeJs, time: "2:14", pct: "27%", words: "96 / 261",
      msgs: [
        ["customer", "Zwei Minuten... hm, ja, das passt gerade so. Ich überlege, ob ich mir wieder stundenlang Karteikarten schreibe oder ob ich mir Nachhilfe hole."],
        ["seller", "Verständlich. Um welche Themen geht es bei diesen Abfragen denn konkret?"],
        ["customer", "Ziemlich breit gefächert, eigentlich alles, was ich lernen muss. Skripte, PDFs, Notizen. Mir geht’s ums Prinzip: aktiv abgefragt werden statt nur lesen."],
        ["seller", "Und was meinen Sie genau mit „Abfragen“ – automatisch erzeugte Karteikarten, oder mehr?"],
        ["customer", "Karteikarten wären schon mal was. Aber das Wichtigste ist für mich das aktive Abfragen – reicht das reine Erstellen dafür?"],
      ],
    },
    en: {
      click: clickEnJs, time: "2:14", pct: "27%", words: "96 / 261",
      msgs: [
        ["customer", "Two minutes... hm, yeah that works. I'm torn between spending hours writing flashcards again or just getting a tutor."],
        ["seller", "Understandable. What topics are we talking about specifically?"],
        ["customer", "Pretty broad, honestly — everything I need to learn. Lecture notes, PDFs, my own notes. For me it's about the principle: being actively quizzed instead of just reading."],
        ["seller", "And what exactly do you mean by “quizzed” — automatically generated flashcards, or something more?"],
        ["customer", "Flashcards would be a start. But the most important thing for me is active recall — is just generating cards enough for that?"],
      ],
    },
  }[lang];

  await shot(outFile, `
    ${hideScrollbarJs}
    ${l.click}
    ${setActivePanel("neues-gespraech")}
    document.getElementById('start-section').style.display = 'none';
    document.getElementById('chat-section').style.display = 'block';
    document.getElementById('avatar-pip').classList.remove('idle');
    document.getElementById('avatar-video').setAttribute('poster', 'avatars/solution_aware-avatar.jpg');
    document.getElementById('stat-time').textContent = ${JSON.stringify(l.time)};
    document.getElementById('stat-pct').textContent = ${JSON.stringify(l.pct)};
    document.getElementById('stat-words').textContent = ${JSON.stringify(l.words)};
    document.getElementById('pct-fill').style.width = ${JSON.stringify(l.pct)};
    document.getElementById('log').innerHTML = '';
    ${l.msgs.map(([role, text]) => addBubbleJs(role, text, lang)).join("\n")}
    document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;
    window.scrollTo(0, document.getElementById('chat-section').getBoundingClientRect().top + window.scrollY - 20);
  `);
}

async function generateResult(outFile, lang) {
  const l = {
    de: {
      click: clickDeJs,
      revealName: "3. Solution-Aware (Lösungs-bewusst)",
      revealState: "Weiß, was er grundsätzlich braucht, aber noch nicht, welche Art von Produkt am besten hilft.",
      verdicts: [
        ["ok", "Redeanteil 33% – ok", "Liegt leicht über der 30%-Vorgabe, aber noch im produktiven Rahmen."],
        ["ok", "Kaum Füllwörter", "Klare, ruhige Ausdrucksweise."],
        ["ok", "Tempo passend (118 wpm)", "Angenehmes Gesprächstempo, genug Raum zum Nachdenken."],
        ["warn", "Kernbedürfnis nur teilweise erkannt", "„Nimmt mir das Denken ab“ wurde noch nicht vollständig aufgegriffen."],
        ["warn", "Discovery: mittel", "Gute Nachfragen, aber noch nicht bis zum Kernbedürfnis vorgedrungen."],
        ["ok", "Einwand gut behandelt", "Skepsis zum reinen Lesen wurde mit konkreten Funktionen entkräftet."],
        ["warn", "Stufe nicht hochgeführt", "Der Interessent wurde noch nicht spürbar weitergebracht."],
      ],
      staerken: ["Gezielte Nachfragen zur Bedarfsklärung", "Geduldiges Eingehen auf Detailfragen", "Guter Gesprächsfluss ohne zu pitchen"],
      verbesserungen: ["Kernbedürfnis „nimmt mir das Denken ab“ stärker aufgreifen", "Eigenen Redeanteil noch weiter reduzieren"],
      nextStep: "Im nächsten Gespräch gezielt fragen: „Wo würde Sie eine Struktur, die Ihnen das Denken abnimmt, am meisten entlasten?“",
    },
    en: {
      click: clickEnJs,
      revealName: "3. Solution-Aware (Solution-aware)",
      revealState: "Knows in general what they need (better retention, more structure), but not yet which type of product helps best.",
      verdicts: [
        ["ok", "Talk share 33% – ok", "Slightly above the 30% guideline, but still within a productive range."],
        ["ok", "Barely any filler words", "Clear, calm phrasing."],
        ["ok", "Pace on point (118 wpm)", "Comfortable pace, enough room to think."],
        ["warn", "Core need only partly recognized", "“Takes the thinking off my hands” wasn't fully picked up on yet."],
        ["warn", "Discovery: medium", "Good follow-up questions, but didn't reach the core need yet."],
        ["ok", "Objection handled well", "Skepticism about “just reading” was addressed with concrete features."],
        ["warn", "Stage not advanced", "The prospect wasn't visibly moved forward yet."],
      ],
      staerken: ["Targeted questions to clarify the need", "Patiently addressed detail questions", "Good conversational flow without pitching"],
      verbesserungen: ["Pick up more strongly on the “takes the thinking off my hands” need", "Reduce your own talk share further"],
      nextStep: "In the next conversation, ask specifically: “Where would a structure that takes the thinking off your hands help you most?”",
    },
  }[lang];

  await shot(outFile, `
    ${hideScrollbarJs}
    ${l.click}
    ${setActivePanel("neues-gespraech")}
    document.getElementById('start-section').style.display = 'none';
    document.getElementById('chat-section').style.display = 'none';
    document.getElementById('result-section').style.display = 'block';
    document.getElementById('reveal-num').textContent = '3';
    document.getElementById('reveal-name').textContent = ${JSON.stringify(l.revealName)};
    document.getElementById('reveal-state').textContent = ${JSON.stringify(l.revealState)};
    document.getElementById('verdict-list').innerHTML = '';
    ${l.verdicts.map(([kind, title, text]) => verdictCardJs(kind, title, text)).join("\n")}
    document.getElementById('list-staerken').innerHTML = '';
    ${fillListJs("list-staerken", l.staerken)}
    document.getElementById('list-verbesserungen').innerHTML = '';
    ${fillListJs("list-verbesserungen", l.verbesserungen)}
    document.getElementById('next-step').textContent = ${JSON.stringify(l.nextStep)};
    window.scrollTo(0, document.getElementById('result-section').getBoundingClientRect().top + window.scrollY - 20);
  `);
}

async function main() {
  await mkdir(DIR, { recursive: true });

  await renderCover("cover-src.html", joinPath(DIR, "cover.png"));
  await renderCover("cover-src-en.html", joinPath(DIR, "cover-en.png"));

  await shot(joinPath(DIR, "_shot-start.png"), `${hideScrollbarJs}\n${clickDeJs}\n${setActivePanel("neues-gespraech")}`);
  await shot(joinPath(DIR, "_shot-start-en.png"), `${hideScrollbarJs}\n${clickEnJs}\n${setActivePanel("neues-gespraech")}`);

  await generateChat(joinPath(DIR, "_shot-chat.png"), "de");
  await generateChat(joinPath(DIR, "_shot-chat-en.png"), "en");

  await generateResult(joinPath(DIR, "_shot-result.png"), "de");
  await generateResult(joinPath(DIR, "_shot-result-en.png"), "en");

  await frame(joinPath(DIR, "_shot-start.png"), joinPath(DIR, "screenshot-start.png"));
  await frame(joinPath(DIR, "_shot-chat.png"), joinPath(DIR, "screenshot-chat.png"));
  await frame(joinPath(DIR, "_shot-result.png"), joinPath(DIR, "screenshot-result.png"));
  await frame(joinPath(DIR, "_shot-start-en.png"), joinPath(DIR, "screenshot-start-en.png"));
  await frame(joinPath(DIR, "_shot-chat-en.png"), joinPath(DIR, "screenshot-chat-en.png"));
  await frame(joinPath(DIR, "_shot-result-en.png"), joinPath(DIR, "screenshot-result-en.png"));

  console.log("done. (temporaere _shot-*.png Dateien koennen geloescht werden)");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
