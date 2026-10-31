import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SELF = `${SB_URL}/functions/v1/katha-admin`;
// @ts-ignore EdgeRuntime is provided by Supabase
const bg = (p: Promise<unknown>) => EdgeRuntime.waitUntil(p.catch((e) => console.error(e)));

async function cfg(): Promise<Record<string, string>> {
  const { data } = await db.from("katha_config").select("key,value");
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
}

function ytId(u: string): string | null {
  u = u.trim();
  if (/^[\w-]{11}$/.test(u)) return u;
  const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// "… - By Hariswarup swami  Day 1 Morning" -> "Hariswarup Swami"
function speakerFromTitle(t: string | null): string | null {
  const m = (t || "").match(/\bby\s+([^-|,]+?\bswam(?:i|y)\b)/i);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ").split(" ").map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// every video of a public playlist, in playlist order (first ~100)
async function playlistIds(u: string): Promise<string[]> {
  const list = (u.match(/[?&]list=([\w-]+)/) || [])[1];
  if (!list) return [];
  const r = await fetch(`https://www.youtube.com/playlist?list=${list}`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" } });
  if (!r.ok) throw new Error("Playlist ખૂલ્યું નહીં (" + r.status + ")");
  const html = await r.text(), seen = new Set<string>(), out: string[] = [];
  for (const m of html.matchAll(/"videoId":"([\w-]{11})"/g)) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  return out;
}

function toSec(t: unknown): number {
  if (typeof t === "number") return Math.max(0, Math.round(t));
  const parts = String(t).trim().split(":").map((x) => parseFloat(x) || 0);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return Math.max(0, Math.round(s));
}
const hms = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");

// ---- video length from the YouTube watch page (null if it can't be read) ----
async function ytDuration(yid: string): Promise<number | null> {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${yid}&hl=en`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36", "Accept-Language": "en" },
    });
    if (!r.ok) return null;
    const h = await r.text();
    const m = h.match(/"lengthSeconds":"(\d+)"/) || h.match(/"approxDurationMs":"(\d+)"/);
    if (!m) return null;
    const n = parseInt(m[1]);
    return m[0].includes("Ms") ? Math.round(n / 1000) : n;
  } catch (_) {
    return null;
  }
}

const LANG: Record<string, { name: string; script: string }> = {
  gu: { name: "Gujarati", script: "Gujarati script" },
  hi: { name: "Hindi", script: "Devanagari script (standard Hindi spelling)" },
  sa: { name: "Sanskrit", script: "Devanagari script (correct Sanskrit spelling, with visarga, anusvara and halant as pronounced)" },
};
const PROMPT = (from: number, to: number, lang = "gu") => {
  const L = LANG[lang] || LANG.gu;
  return `You are transcribing a ${L.name} religious discourse (katha / pravachan, e.g. on the Upanishads, Vachanamrut or Shikshapatri) from this YouTube video.
You are given ONLY the part of the video from ${hms(from)} to ${hms(to)}.
Transcribe EVERY spoken word in that part verbatim in ${L.script}, from its beginning to its end. Do not summarise, translate, skip or correct the speaker. If the speaker switches language for a while (a Sanskrit shloka, a Gujarati or Hindi sentence, a kirtan line), keep those words as spoken, written in the same ${L.script}. Use natural punctuation.
Split the transcript into consecutive passages of roughly 20-40 seconds each (a few sentences), each starting where the speaker begins that passage.
For each passage give:
- "start": the start time as "HH:MM:SS", measured from the START OF THE WHOLE VIDEO (so the first passage is near ${hms(from)})
- "text": the transcript of that passage, in ${L.script}
- "roman": the same passage transliterated into simple lowercase English letters (e.g. "maharaj e mantra kone apyo")
If this part has no speech at all, return an empty array. Return only the JSON array.`;
};

type Seg = { start: string; text: string; roman: string };

// Free-tier keys get a small number of requests per model per day. A 429 that says "per day" will not
// clear by retrying; note when it resets so the queue can wait instead of failing.
function quotaError(status: number, body: string, model: string) {
  const daily = status === 429 && /per day|PerDay/i.test(body);
  let wait = 0;
  const m = body.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (m) wait = (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + Math.ceil(+(m[3] || 0));
  return Object.assign(new Error(`Gemini ${status} (${model})${daily ? " daily limit" : ""}: ${body.slice(0, 200)}`), { status, daily, wait });
}
async function setQuotaPause(seconds: number) {
  const until = new Date(Date.now() + Math.max(600, seconds || 3600) * 1000).toISOString();
  await db.from("katha_config").upsert({ key: "quota_until", value: until });
  return until;
}
async function quotaPaused(): Promise<string | null> {
  const { data } = await db.from("katha_config").select("value").eq("key", "quota_until").maybeSingle();
  return data?.value && new Date(data.value).getTime() > Date.now() ? data.value : null;
}

async function gemini(key: string, model: string, url: string, from: number, to: number, lang: string): Promise<Seg[]> {
  const body = {
    contents: [{
      parts: [
        { file_data: { file_uri: url }, video_metadata: { start_offset: `${from}s`, end_offset: `${to}s`, fps: 0.2 } },
        { text: PROMPT(from, to, lang) },
      ],
    }],
    generationConfig: {
      temperature: 0,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { start: { type: "STRING" }, text: { type: "STRING" }, roman: { type: "STRING" } },
          required: ["start", "text", "roman"],
        },
      },
    },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw quotaError(r.status, txt, model);
  const j = JSON.parse(txt);
  const cand = j.candidates?.[0];
  const out = cand?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  if (!out) throw new Error(`Gemini returned no text (${cand?.finishReason ?? "?"}): ` + txt.slice(0, 200));
  try {
    return JSON.parse(out) as Seg[];
  } catch (_) {
    throw new Error(`Gemini JSON cut off (${cand?.finishReason ?? "?"}), ${out.length} chars`);
  }
}

async function transcribe(c: Record<string, string>, yid: string, from: number, to: number, lang: string): Promise<Seg[]> {
  const url = `https://www.youtube.com/watch?v=${yid}`;
  const models = [c.model || "gemini-3.5-flash", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-flash-latest"];
  const errs: string[] = [];
  let allDaily = true, wait = 0;
  for (const m of [...new Set(models)]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await gemini(c.gemini_key, m, url, from, to, lang);
      } catch (e: any) {
        errs.push(m + ": " + String(e.message).slice(0, 160));
        if (e.daily) { wait = Math.max(wait, e.wait || 0); break; } // this model is done for today
        if (e.status !== 404) allDaily = false;
        if (e.status === 401 || e.status === 403) throw Object.assign(new Error(errs.join(" | ")), { fatal: true });
        if (e.status === 503 || e.status === 429 || e.status === 500) {
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
          continue;
        }
        break; // other errors: next model
      }
    }
  }
  throw Object.assign(new Error(errs.join(" | ")), { daily: allDaily && wait > 0, wait });
}

// Gemini sometimes returns clip-relative times; put them back on the whole-video clock.
function absolute(segs: Seg[], from: number, to: number): number[] {
  const t = segs.map((s) => toSec(s.start));
  if (from > 0 && t.length && Math.max(...t) <= to - from + 30 && Math.min(...t) < from - 30) {
    return t.map((x) => x + from);
  }
  return t.map((x) => Math.min(Math.max(x, from), to));
}

// ---------------- translation (public, cached per passage + language) ----------------
const TARGET: Record<string, string> = {
  gu: "Gujarati, in Gujarati script",
  hi: "simple, natural Hindi, in Devanagari script",
  sa: "simple classical Sanskrit, in Devanagari script",
  en: "clear, simple English",
};
async function translateText(c: Record<string, string>, text: string, from: string, to: string): Promise<string> {
  const prompt = `This is one passage from a spoken Swaminarayan katha (religious discourse) in ${LANG[from]?.name || "Gujarati"}.
Translate it into ${TARGET[to]}. Keep the meaning and the speaker's tone. Keep names of Bhagwan, saints and scriptures recognisable. Translate quoted shlokas too, but keep a Sanskrit shloka unchanged when translating into Sanskrit.
Return only the translation, with no notes.

${text}`;
  const models = [c.model || "gemini-3.5-flash", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest"];
  const errs: string[] = [];
  for (const m of [...new Set(models)]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": c.gemini_key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } }),
      });
      const t = await r.text();
      if (r.ok) {
        const out = JSON.parse(t).candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("").trim();
        if (out) return out;
        errs.push(m + ": empty"); break;
      }
      errs.push(`${m}: ${r.status}${/per day/i.test(t) ? " daily" : ""}`);
      if (/per day/i.test(t)) break;
      if (r.status === 503 || r.status === 429 || r.status === 500) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
      break;
    }
  }
  throw new Error("translation failed: " + errs.join(" | "));
}

async function translate(passageId: number, to: string) {
  if (!TARGET[to] || !passageId) return json({ error: "bad request" }, 400);
  const { data: hit } = await db.from("katha_translations").select("text").eq("passage_id", passageId).eq("lang", to).maybeSingle();
  if (hit) return json({ text: hit.text, cached: true });
  const { data: p } = await db.from("katha_passages").select("id,text,video_id,hidden").eq("id", passageId).maybeSingle();
  if (!p || p.hidden) return json({ error: "not found" }, 404);
  const { data: v } = await db.from("katha_videos").select("lang,hidden").eq("id", p.video_id).maybeSingle();
  if (!v || v.hidden) return json({ error: "not found" }, 404);
  const from = v?.lang || "gu";
  if (from === to) return json({ same: true });
  // keep the free Gemini key safe from a flood of new requests
  const { count } = await db.from("katha_translations").select("passage_id", { count: "exact", head: true })
    .gt("created_at", new Date(Date.now() - 60_000).toISOString());
  if ((count ?? 0) > 40) return json({ error: "busy" }, 429);
  const c = await cfg();
  let text = "";
  try { text = await translateText(c, p.text, from, to); }
  catch (e: any) { return json({ error: /daily/.test(String(e.message)) ? "quota" : "failed" }, 429); }
  await db.from("katha_translations").upsert({ passage_id: p.id, lang: to, text });
  return json({ text });
}

// ---------------- queue ----------------

async function chunkMin(c: Record<string, string>) {
  const n = parseInt(c.chunk_min || "10");
  return (n > 0 && n <= 30 ? n : 10) * 60;
}

async function makeChunks(videoId: number, yid: string) {
  const c = await cfg();
  const size = await chunkMin(c);
  const dur = await ytDuration(yid);
  await db.from("katha_chunks").delete().eq("video_id", videoId);
  await db.from("katha_passages").delete().eq("video_id", videoId);
  const rows: any[] = [];
  if (dur) {
    for (let s = 0, i = 0; s < dur; s += size, i++) rows.push({ video_id: videoId, idx: i, start_sec: s, end_sec: Math.min(s + size, dur) });
  } else {
    rows.push({ video_id: videoId, idx: 0, start_sec: 0, end_sec: size }); // length unknown: grow one chunk at a time
  }
  await db.from("katha_chunks").insert(rows);
  await db.from("katha_videos").update({
    status: "processing", error: null, passages: 0, duration_sec: dur, chunks_total: dur ? rows.length : 0, chunks_done: 0,
  }).eq("id", videoId);
}

async function refreshVideo(videoId: number) {
  const { data: ch } = await db.from("katha_chunks").select("status,error,idx,start_sec").eq("video_id", videoId).order("start_sec");
  const { count } = await db.from("katha_passages").select("id", { count: "exact", head: true }).eq("video_id", videoId);
  const { data: v } = await db.from("katha_videos").select("duration_sec").eq("id", videoId).single();
  const list = ch ?? [];
  const done = list.filter((x: any) => x.status === "done").length;
  const bad = list.filter((x: any) => x.status === "error");
  const open = list.filter((x: any) => x.status === "pending" || x.status === "processing").length;
  const upd: any = { passages: count ?? 0, chunks_done: done, chunks_total: v?.duration_sec ? list.length : 0 };
  if (!open) {
    if (bad.length) {
      upd.status = "error";
      upd.error = `${list.length} માંથી ${bad.length} ટુકડા નિષ્ફળ (${bad.map((b: any) => Math.floor(b.start_sec / 60) + " મિનિટ").join(", ")} થી): ${String(bad[0].error).slice(0, 500)}`;
    } else {
      upd.status = "done";
      upd.error = null;
      upd.chunks_total = list.length;
    }
  }
  await db.from("katha_videos").update(upd).eq("id", videoId);
}

async function busy(): Promise<boolean> {
  const { count } = await db.from("katha_chunks").select("id", { count: "exact", head: true })
    .eq("status", "processing").gt("updated_at", new Date(Date.now() - 3 * 60_000).toISOString());
  return (count ?? 0) > 0;
}

// process ONE chunk, then hand off to a fresh invocation for the next one
async function tick(pass: string) {
  if (await quotaPaused()) return "quota";
  if (await busy()) return "busy";
  const { data: ck, error } = await db.rpc("katha_claim_chunk");
  if (error) throw error;
  if (!ck || !ck.id) return "idle";
  const c = await cfg();
  const { data: v } = await db.from("katha_videos").select("id,youtube_id,duration_sec,lang").eq("id", ck.video_id).single();
  if (!v) {
    await db.from("katha_chunks").delete().eq("id", ck.id);
  } else {
    try {
      const segs = (await transcribe(c, v.youtube_id, ck.start_sec, ck.end_sec, v.lang || "gu")).filter((s) => s.text && s.text.trim());
      const times = absolute(segs, ck.start_sec, ck.end_sec);
      const rows = segs.map((s, i) => ({ video_id: v.id, start_sec: times[i], text: s.text.trim(), roman: (s.roman || "").trim() }));
      // replace whatever an earlier attempt stored for this time range
      await db.from("katha_passages").delete().eq("video_id", v.id).gte("start_sec", ck.start_sec).lt("start_sec", ck.end_sec);
      for (let i = 0; i < rows.length; i += 200) {
        const { error: e } = await db.from("katha_passages").insert(rows.slice(i, i + 200));
        if (e) throw e;
      }
      await db.from("katha_videos").update({ error: null }).eq("id", v.id).like("error", "⏸%");
      await db.from("katha_chunks").update({ status: "done", error: null, passages: rows.length, updated_at: new Date().toISOString() }).eq("id", ck.id);
      // length unknown: if speech ran to the end of this chunk, queue the next one (cap 8 h)
      if (!v.duration_sec && rows.length && Math.max(...times) >= ck.end_sec - 120 && ck.end_sec < 8 * 3600) {
        const size = await chunkMin(c);
        await db.from("katha_chunks").upsert(
          { video_id: v.id, idx: ck.idx + 1, start_sec: ck.end_sec, end_sec: ck.end_sec + size },
          { onConflict: "video_id,start_sec", ignoreDuplicates: true },
        );
      }
    } catch (e: any) {
      if (e.daily) {
        const until = await setQuotaPause(e.wait);
        await db.from("katha_chunks").update({ status: "pending", attempts: Math.max(0, ck.attempts - 1), error: "daily quota", updated_at: new Date().toISOString() }).eq("id", ck.id);
        const hh = new Date(until).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
        await db.from("katha_videos").update({ error: `⏸ Gemini ની આજની મફત મર્યાદા પૂરી થઈ. ભારતના સમય પ્રમાણે ${hh} પછી આપમેળે આગળ ચાલશે.` }).eq("id", v.id);
        return "quota";
      }
      const final = e.fatal || ck.attempts >= 4;
      await db.from("katha_chunks").update({
        status: final ? "error" : "pending", error: String(e?.message ?? e).slice(0, 800), updated_at: new Date().toISOString(),
      }).eq("id", ck.id);
    }
    await refreshVideo(v.id);
  }
  kick(pass);
  return "worked";
}

function kick(pass: string) {
  bg(fetch(SELF, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass, action: "tick" }) }));
}

async function enqueue(videoId: number, yid: string, pass: string) {
  await makeChunks(videoId, yid);
  kick(pass);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    if (b.action === "translate") return await translate(+b.passage_id, String(b.lang || ""));
    if (b.action === "report") {
      // public "report a mistake" form; a small cap keeps spam out
      const msg = String(b.message || "").trim().slice(0, 2000);
      if (msg.length < 2) return json({ error: "empty" }, 400);
      const { count } = await db.from("katha_reports").select("id", { count: "exact", head: true })
        .gt("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
      if ((count ?? 0) > 20) return json({ error: "busy" }, 429);
      const { error } = await db.from("katha_reports").insert({
        message: msg, name: String(b.name || "").trim().slice(0, 100) || null,
        youtube_id: /^[\w-]{11}$/.test(b.youtube_id || "") ? b.youtube_id : null,
        start_sec: Number.isFinite(+b.start_sec) && b.start_sec !== null && b.start_sec !== "" ? Math.round(+b.start_sec) : null,
        passage_id: +b.passage_id || null, page: String(b.page || "").slice(0, 200) || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const c = await cfg();
    if (!b.pass || b.pass !== c.admin_pass) return json({ error: "ખોટો પાસવર્ડ" }, 401);

    if (b.action === "check") return json({ ok: true });

    if (b.action === "tick") {
      bg(tick(b.pass));
      return json({ ok: true });
    }

    if (b.action === "list") {
      const { data } = await db.from("katha_videos").select("*").order("created_at", { ascending: false }).limit(200);
      return json({ videos: data });
    }

    if (b.action === "reports") {
      const { data } = await db.from("katha_reports").select("*").order("created_at", { ascending: false }).limit(100);
      return json({ reports: data });
    }

    if (b.action === "report_status") {
      await db.from("katha_reports").update({ status: String(b.status || "seen") }).eq("id", b.id);
      return json({ ok: true });
    }

    if (b.action === "chunks") {
      const { data } = await db.from("katha_chunks").select("idx,start_sec,end_sec,status,attempts,passages,error").eq("video_id", b.id).order("start_sec");
      return json({ chunks: data });
    }

    // hide a whole katha, or one passage, from the public site (admin still sees it)
    if (b.action === "hide") {
      await db.from("katha_videos").update({ hidden: !!b.hidden }).eq("id", b.id);
      return json({ ok: true });
    }

    if (b.action === "passages") {
      const { data } = await db.from("katha_passages").select("id,start_sec,text,hidden").eq("video_id", b.id).order("start_sec").limit(5000);
      return json({ passages: data });
    }

    if (b.action === "hide_passage") {
      await db.from("katha_passages").update({ hidden: !!b.hidden }).eq("id", b.id);
      return json({ ok: true });
    }

    if (b.action === "delete") {
      await db.from("katha_videos").delete().eq("id", b.id);
      return json({ ok: true });
    }

    if (b.action === "edit") {
      const upd: any = { title: b.title, speaker: b.speaker, series: b.series };
      if (LANG[b.lang]) upd.lang = b.lang;
      await db.from("katha_videos").update(upd).eq("id", b.id);
      return json({ ok: true });
    }

    if (b.action === "retry") {
      const { data: v } = await db.from("katha_videos").select("id,youtube_id").eq("id", b.id).single();
      if (!v) return json({ error: "not found" }, 404);
      const { data: bad } = await db.from("katha_chunks").select("id").eq("video_id", v.id).neq("status", "done");
      const { count: all } = await db.from("katha_chunks").select("id", { count: "exact", head: true }).eq("video_id", v.id);
      if (b.full || !all) {
        await db.from("katha_videos").update({ status: "processing", error: null }).eq("id", v.id);
        bg(enqueue(v.id, v.youtube_id, b.pass)); // start over
      } else {
        // only redo the chunks that failed; finished ones are kept
        if (bad?.length) await db.from("katha_chunks").update({ status: "pending", attempts: 0, error: null }).in("id", bad.map((x: any) => x.id));
        await db.from("katha_videos").update({ status: "processing", error: null }).eq("id", v.id);
        kick(b.pass);
      }
      return json({ ok: true });
    }

    if (b.action === "playlist") {
      const ids = await playlistIds(b.url || "");
      if (!ids.length) return json({ error: "Playlist માં વીડિયો ન મળ્યા" }, 400);
      const { data: have } = await db.from("katha_videos").select("youtube_id").in("youtube_id", ids);
      const old = new Set((have ?? []).map((x: any) => x.youtube_id));
      // titles, so the sevak can tick only the kathas they want
      const items = await Promise.all(ids.map(async (id) => {
        let title = "";
        try { const o = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`); if (o.ok) title = (await o.json()).title || ""; } catch (_) { /* ignore */ }
        return { id, title, speaker: speakerFromTitle(title), have: old.has(id) };
      }));
      return json({ ok: true, items, ids: ids.filter((x) => !old.has(x)), already: ids.filter((x) => old.has(x)).length });
    }

    if (b.action === "add") {
      const yid = ytId(b.url || "");
      if (!yid) return json({ error: "YouTube લિંક બરાબર નથી" }, 400);
      let title = b.title || null, channel = null;
      try {
        const o = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${yid}`);
        if (o.ok) { const oj = await o.json(); title = title || oj.title; channel = oj.author_name; }
      } catch (_) { /* ignore */ }
      const { data: v, error } = await db.from("katha_videos")
        .upsert({ youtube_id: yid, title, channel, speaker: b.speaker || speakerFromTitle(title), series: b.series || null, lang: LANG[b.lang] ? b.lang : "gu", status: "processing", error: null }, { onConflict: "youtube_id" })
        .select("id").single();
      if (error) return json({ error: error.message }, 500);
      bg(enqueue(v.id, yid, b.pass));
      return json({ ok: true, id: v.id, title });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
