import json, re
import os
HERE = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(HERE, '..', '..', 'index.html'), encoding='utf-8').read()
sample = json.load(open(os.path.join(HERE, 'sample.json'), encoding='utf-8'))
trj = json.load(open(os.path.join(HERE, 'tr.json'), encoding='utf-8'))
for r in sample:
    r['passage_id'] = r['id'] = trj['ids'][str(r['start_sec'])]

head, body = s.split('</head>')
title = '<title>કચ્છ સત્સંગ પ્રિવ્યૂ</title>'
fonts = re.search(r'<script>\n/\* fonts load.*?</script>', head, re.S).group(0)
fonts += '\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+Devanagari:wght@400;600&display=swap">'
style = head[head.index('<style>'):head.index('</style>') + 8]
body = body.replace('<body>', '').replace('</body>', '').replace('</html>', '')
banner = ('<div style="margin:10px 60px 0 0;padding:8px 12px;border:1px dashed var(--gold);font-size:14px;line-height:1.6;'
          'color:var(--ink-2);background:var(--card)">🔍 <b>પ્રિવ્યૂ</b> · ⚙️ દબાવીને સેટિંગ બદલો. અહીં સતી ગીતાના 12 નમૂનાના ફકરા છે '
          '(શોધો: મુક્તાનંદ, મંત્ર, ભગવાન). અનુવાદ ફક્ત થોડા ફકરાના જ મૂક્યા છે. અહીં વીડિયોની જગ્યાએ 5 સેકન્ડનો નમૂનો ફરે છે, સાચો વીડિયો live સાઈટ પર ચાલશે.</div>')
body = body.replace('<div class="wrap">', '<div class="wrap">\n' + banner, 1)

patch = '''
/* ---- preview only: sample passages and translations, no network ---- */
const SAMPLE = __SAMPLE__;
const TRS = __TRS__;
const META = { youtube_id: "q8nafSZXRs4", video_id: 2, title: "સતી ગીતા – Day 1", speaker: "કૃષ્ણસ્વરૂપ સ્વામી", series: "સતી ગીતા" };
rpc = async (name, body) => {
  if (name === "katha_stats") return { kathas: 1, passages: SAMPLE.length, series: ["સતી ગીતા"], speakers: ["કૃષ્ણસ્વરૂપ સ્વામી"] };
  const q = (body.q || "").trim(), ql = q.toLowerCase(), qg = toGu(q);
  return SAMPLE.filter((s) => s.text.includes(qg) || s.roman.toLowerCase().includes(ql)).map((s) => ({ ...META, ...s }));
};
const _fetch = window.fetch.bind(window);
const jres = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
window.fetch = (u, o) => {
  if (String(u).includes("katha_passages")) return Promise.resolve(jres(SAMPLE));
  if (String(u).includes("katha-admin")) {
    const b = JSON.parse(o.body);
    if (b.action === "report") return Promise.resolve(jres({ ok: true }));
    if (b.action === "translate") {
      if (b.lang === "gu") return Promise.resolve(jres({ same: true }));
      const t = TRS[b.passage_id + ":" + b.lang];
      return new Promise((ok) => setTimeout(() => ok(t ? jres({ text: t }) : jres({ error: "preview" }, 429)), 500));
    }
  }
  return _fetch(u, o);
};
// preview: YouTube cannot run inside the preview, so a drawn 5-second "katha" loop stands in for it,
// and every 5 seconds the next passage of the katha appears in the live text below.
let __x = 0, __sim = null, __raf = null;
function fakeVideo(canvas, title) {
  const ctx = canvas.getContext("2d"); const t0 = performance.now();
  const fit = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * 2; canvas.height = r.height * 2; };
  fit();
  function frame(now) {
    const W = canvas.width, H = canvas.height, s = H / 360, t = ((now - t0) / 1000) % 5;
    // stage
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#3a120c"); g.addColorStop(1, "#140806");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // arch behind the speaker
    ctx.strokeStyle = "rgba(214,167,76,.55)"; ctx.lineWidth = 4 * s;
    ctx.beginPath(); ctx.moveTo(W / 2 - 150 * s, H); ctx.lineTo(W / 2 - 150 * s, 130 * s); ctx.quadraticCurveTo(W / 2, 20 * s, W / 2 + 150 * s, 130 * s); ctx.lineTo(W / 2 + 150 * s, H); ctx.stroke();
    // seat
    ctx.fillStyle = "#7a1f17"; ctx.fillRect(W / 2 - 110 * s, 270 * s, 220 * s, 90 * s);
    ctx.fillStyle = "#b8892f"; ctx.fillRect(W / 2 - 110 * s, 266 * s, 220 * s, 8 * s);
    // speaker: saffron robe, head nods a little, hand moves while speaking
    const nod = Math.sin(t * Math.PI * 0.8) * 3 * s, hand = Math.sin(t * Math.PI * 1.6) * 14 * s;
    ctx.fillStyle = "#d9772b"; ctx.beginPath(); ctx.moveTo(W / 2 - 80 * s, 275 * s); ctx.quadraticCurveTo(W / 2, 140 * s, W / 2 + 80 * s, 275 * s); ctx.fill();
    ctx.fillStyle = "#c98a5e"; ctx.beginPath(); ctx.arc(W / 2, 150 * s + nod, 30 * s, 0, 7); ctx.fill();
    ctx.fillStyle = "#e9e1d0"; ctx.fillRect(W / 2 - 5 * s, 118 * s + nod, 10 * s, 14 * s); // tilak
    ctx.strokeStyle = "#c98a5e"; ctx.lineWidth = 11 * s; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(W / 2 + 40 * s, 225 * s); ctx.lineTo(W / 2 + 85 * s, 205 * s - hand); ctx.stroke();
    // microphone
    ctx.strokeStyle = "#888"; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.moveTo(W / 2 - 60 * s, 360 * s); ctx.lineTo(W / 2 - 35 * s, 190 * s); ctx.stroke();
    ctx.fillStyle = "#333"; ctx.beginPath(); ctx.ellipse(W / 2 - 33 * s, 182 * s, 9 * s, 13 * s, -0.3, 0, 7); ctx.fill();
    // diya with a flickering flame
    const fx = 60 * s, fy = 300 * s, fl = 1 + Math.sin(now / 90) * 0.12 + Math.sin(now / 37) * 0.06;
    ctx.fillStyle = "#b8892f"; ctx.beginPath(); ctx.ellipse(fx, fy + 14 * s, 26 * s, 9 * s, 0, 0, 7); ctx.fill();
    const fg = ctx.createRadialGradient(fx, fy - 6 * s, 1, fx, fy - 6 * s, 40 * s * fl); fg.addColorStop(0, "rgba(255,210,120,.65)"); fg.addColorStop(1, "rgba(255,160,60,0)");
    ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(fx, fy - 6 * s, 40 * s * fl, 0, 7); ctx.fill();
    ctx.fillStyle = "#ffd27a"; ctx.beginPath(); ctx.ellipse(fx, fy - 6 * s, 6 * s, 15 * s * fl, 0, 0, 7); ctx.fill();
    // voice bars
    for (let i = 0; i < 9; i++) { const h = (8 + Math.abs(Math.sin(now / 160 + i * 0.9)) * 30) * s; ctx.fillStyle = "rgba(214,167,76,.8)"; ctx.fillRect(W - 150 * s + i * 14 * s, 330 * s - h, 8 * s, h); }
    // title, clock and a 5-second progress line
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.font = `${16 * s}px "Noto Serif Gujarati", serif`; ctx.fillText(title, 14 * s, 26 * s);
    ctx.font = `${14 * s}px sans-serif`; ctx.fillText("▶ " + fmt0(Math.floor(__x)), 14 * s, H - 14 * s);
    ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(0, H - 4 * s, W, 4 * s);
    ctx.fillStyle = "#c0392b"; ctx.fillRect(0, H - 4 * s, W * (t / 5), 4 * s);
    __raf = requestAnimationFrame(frame);
  }
  cancelAnimationFrame(__raf); __raf = requestAnimationFrame(frame);
}
play = (yid, t, info) => {
  cur = { yid, t, info }; addHistory(info, yid, t);
  $("#vid").innerHTML = `<canvas id="fakeVid" style="width:100%;height:100%;display:block" aria-label="નમૂનાનો વીડિયો"></canvas>`;
  $("#player").hidden = false; document.body.classList.add("playing");
  fakeVideo($("#fakeVid"), (info?.title || "કથા") + " · પ્રિવ્યૂ");
  startLive(info, t); __x = t;
  clearInterval(__sim);
  // every 5 seconds jump to the next passage, and start over at the end
  __sim = setInterval(() => {
    const segs = live.segs; if (!segs.length) return;
    const i = segs.findIndex((g) => g.start_sec > __x);
    __x = i === -1 ? segs[0].start_sec : segs[i].start_sec;
    liveTick(__x);
  }, 5000);
  if (last) render(last.rows, last.q);
};
liveSeek = (sec) => { __x = sec; if (cur) cur.t = sec; liveTick(sec); };
$("#closeP").addEventListener("click", () => { clearInterval(__sim); cancelAnimationFrame(__raf); });
'''.replace('__SAMPLE__', json.dumps(sample, ensure_ascii=False)).replace('__TRS__', json.dumps(trj['tr'], ensure_ascii=False))
anchor = 'window.addEventListener("hashchange", route);'
assert anchor in body
body = body.replace(anchor, patch + anchor, 1)
out = title + '\n<meta name="theme-color" content="#6e1f14">\n' + fonts + '\n' + style + '\n' + body.strip() + '\n'
open(os.path.join(HERE, 'kutch-satsang-preview.html'), 'w', encoding='utf-8').write(out)
print(len(out))
