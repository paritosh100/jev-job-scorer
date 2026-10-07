const $ = (id) => document.getElementById(id);

const color = (s) => (s <= 3 ? "#dc3545" : s <= 5 ? "#fd7e14" : s <= 7 ? "#ffc107" : "#28a745");

function run(job) {
  $("err").textContent = "";
  chrome.runtime.sendMessage({ type: "score", job }, (res) => {
    if (!res?.ok) $("err").textContent = res?.error || "Error";
  });
}

$("go").onclick = () => run({ text: $("text").value.trim(), title: "Pasted job" });
$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("csv").onclick = async () => {
  const { scores = {} } = await chrome.storage.local.get("scores");
  const esc = (v) => `"${String(v ?? "").replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`; // ' blocks spreadsheet formulas
  const rows = Object.values(scores).map((s) =>
    [new Date(s.timestamp).toISOString(), s.company, s.title, s.score, s.url, s.apiMs].map(esc).join(","));
  const blob = new Blob([["date,company,title,score,link,api_ms", ...rows].join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "jev-scores.csv" });
  a.click();
};

// Panel stays open; content.js scores jobs as you browse. background.js keeps `current` (this page) and `scores` (history).
let e2e = {};
function render({ current, scores = {} }) {
  const s = current;
  $("empty").hidden = !!s;
  $("result").hidden = !s;
  $("err").textContent = s?.error || "";
  if (s) {
    const done = s.score != null;
    $("badge").textContent = done ? s.score : s.error ? "!" : "…";
    $("badge").style.background = done ? color(s.score) : "";
    $("title").textContent = s.title || "";
    $("company").textContent = s.pending ? "Analyzing job…" : s.company || "";
    $("tier").hidden = $("meets").hidden = $("lat").hidden = !done;
    if (done) {
      $("tier").textContent = s.tier ?? "";
      const fmt = (ms) => (ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s");
      // measured once, when the result first renders: detection -> score on screen
      if (s.detectedAt && e2e.at !== s.detectedAt) {
        e2e = { at: s.detectedAt, ms: Date.now() - s.detectedAt };
        console.log(`[Jev] end-to-end ${e2e.ms}ms (backend ${s.ms}ms${s.cached ? ", cached" : ""}): ${s.title}`);
      }
      $("lat").textContent = (s.cached ? "cached · " : "") + (e2e.at === s.detectedAt ? `${fmt(e2e.ms)} total · ` : "") + `${fmt(s.ms)} backend`;
      $("meets").textContent = s.meetsRequirements ? "Meets core requirements" : "Missing core requirements";
      $("meets").className = "chip " + (s.meetsRequirements ? "yes" : "no");
    }
  }
  $("sentBox").hidden = s?.score == null;
  if (s?.score != null) {
    const sent = s.sent || "";
    $("sentSum").textContent = s.sent ? `What was sent to Jev (${sent.length.toLocaleString()} chars)` : "What was sent to Jev";
    if ($("sent").textContent !== sent) $("sent").textContent = sent;
  }
  $("qBox").hidden = !s?.questions || s.score == null;
  if (s?.questions) {
    const q = JSON.stringify(s.questions, null, 2);
    if ($("q").textContent !== q) $("q").textContent = q;
  }
  const all = Object.values(scores).sort((a, b) => b.timestamp - a.timestamp).filter((r) => r.timestamp !== s?.timestamp);
  $("recent").replaceChildren(...all.slice(0, 10).map((r) => {
    const li = document.createElement("li"), a = document.createElement("a");
    const dot = document.createElement("span"), meta = document.createElement("div"), t = document.createElement("div"), c = document.createElement("div");
    if (r.url) { a.href = r.url; a.target = "_blank"; }
    dot.className = "dot"; dot.textContent = r.score; dot.style.background = color(r.score);
    meta.className = "meta"; t.textContent = r.title; c.className = "sub"; c.textContent = r.company;
    meta.append(t, c); a.append(dot, meta); li.append(a);
    return li;
  }));
}
const refresh = () => chrome.storage.local.get(["current", "scores"]).then(render);
refresh();
chrome.storage.onChanged.addListener((c) => (c.current || c.scores) && refresh());

// Text size: scales the whole panel, remembered across sessions.
let scale = 1;
const setScale = (s) => {
  scale = Math.min(1.6, Math.max(0.8, Math.round(s * 10) / 10));
  document.body.style.zoom = scale;
  chrome.storage.local.set({ fontScale: scale });
};
$("smaller").onclick = () => setScale(scale - 0.1);
$("bigger").onclick = () => setScale(scale + 0.1);
chrome.storage.local.get("fontScale").then((r) => r.fontScale && setScale(r.fontScale));
