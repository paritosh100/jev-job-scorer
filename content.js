// Floating score panel on job boards. Auto-scores whenever the visible job changes.
const SELECTORS = [
  ".jobs-details__main-content", ".show-more-less-html__markup", // LinkedIn
  ".jobsearch-JobComponent", ".jobsearch-DesktopStickyContainer", // Indeed
  ".JobDescription__Container", ".gd-ui-card", // Glassdoor
  ".job__description", "#content .job-post", // Greenhouse
  ".ashby-job-posting-right-pane", // Ashby
  "#job-post-body", "[class*='job-description']", // Built In
];

// Only run on URLs that can hold a job posting (profiles, feeds, company pages etc. are skipped).
// Per host; a host with no entry here is never scored.
const JOB_URLS = {
  "linkedin.com": /\/jobs\//,
  "indeed.com": /\/viewjob|[?&](vjk|jk)=/,
  "glassdoor.com": /job-listing|jobListingId=|[?&]jl=/,
  "greenhouse.io": /\/jobs\/\d+|gh_jid=/,
  "ashbyhq.com": /ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}/,
  "builtin.com": /\/job\//,
};
const SINGLE_JOB_SITES = /greenhouse\.io|ashbyhq\.com|builtin\.com/; // one job per page, so <main> is a safe fallback
const onJobUrl = () => Object.entries(JOB_URLS).some(([h, re]) => location.hostname.endsWith(h) && re.test(location.href));

// Second gate: the text itself has to read like a job description, not a profile or feed.
const JD_WORDS = /responsibilit|requirements|qualifications|you will|you'll|we are looking|we're looking|what you|apply|benefits|equal opportunity|about the (job|role|team)/gi;
const looksLikeJD = (t) => new Set((t.match(JD_WORDS) || []).map((w) => w.toLowerCase())).size >= 2;

// LinkedIn's class names are obfuscated and change often, so anchor on the visible "About the job" heading.
let bodyEl; // last job container; reused while still attached so most reads skip the full-page scan
function findBody() {
  if (bodyEl?.isConnected && bodyEl.innerText.length > 200) return bodyEl;
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,span,div")].filter(
    (e) => !e.children.length && /^(about the job|job description|about this job|full job description)$/i.test(e.innerText?.trim()));
  for (const h of heads) {
    let n = h.parentElement;
    while (n && n.innerText.length < 300) n = n.parentElement;
    if (n && n.innerText.length < 30000) return (bodyEl = n);
  }
  const el = SELECTORS.map((s) => document.querySelector(s)).find((e) => e?.innerText.trim())
    || (SINGLE_JOB_SITES.test(location.hostname) && document.querySelector("main"));
  return (bodyEl = el || undefined);
}

function read() {
  if (!onJobUrl()) return null;
  const body = findBody();
  if (!body) return null;
  const text = body.innerText.replace(/\s+/g, " ").trim();
  const title = document.querySelector("h1")?.innerText.trim() || document.title.split(" | ")[0];
  const company = document.querySelector(".job-details-jobs-unified-top-card__company-name, [data-company-name]")?.innerText.trim() || document.title.split(" | ")[1] || "";
  return text.length > 200 && looksLikeJD(text) ? { text, title, company, url: location.href } : null;
}

const color = (s) => (s <= 3 ? "#dc3545" : s <= 5 ? "#fd7e14" : s <= 7 ? "#ffc107" : "#28a745");

// Shadow DOM isolates our styles from the page; textContent only, so page text can't inject markup.
const host = document.createElement("div");
const root = host.attachShadow({ mode: "closed" });
// Built with DOM calls + CSSOM styles, not innerHTML/<style>: LinkedIn's Trusted Types / CSP would block those.
const el = (css, text = "") => {
  const e = document.createElement("div");
  Object.assign(e.style, css);
  e.textContent = text;
  return e;
};
const panel = el({ position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647", width: "220px",
  padding: "12px", background: "#fff", color: "#222", border: "1px solid #ccc", borderRadius: "8px",
  font: "13px system-ui", boxShadow: "0 2px 10px rgba(0,0,0,.25)" });
const closeBtn = el({ position: "absolute", top: "2px", right: "8px", cursor: "pointer", fontSize: "18px" }, "×");
const tEl = el({ marginRight: "16px" });
const sEl = el({ fontSize: "40px", fontWeight: "700", textAlign: "center" });
const dEl = el({});
panel.append(closeBtn, tEl, sEl, dEl);
root.append(panel);
let closed = false;
closeBtn.onclick = () => { closed = true; host.remove(); };

function show(title, big, detail, c = "#222") {
  tEl.textContent = title;
  sEl.textContent = big;
  sEl.style.color = c;
  dEl.textContent = detail;
  if (!closed && !host.isConnected) document.documentElement.append(host);
}

let seen = "", seenAt = 0, scored = "";

function tick() {
  if (!chrome.runtime?.id) return observer.disconnect(); // extension was reloaded
  const job = read();
  if (!job) return console.debug("[Jev] no job text found on this page yet");
  // new text: remember when it appeared, then re-check shortly; unchanged on that re-check = page finished loading
  if (job.text !== seen) { seen = job.text; seenAt = Date.now(); return schedule(SETTLE_MS); }
  if (job.text === scored) return;
  scored = job.text;
  job.detectedAt = seenAt; // first moment this job text appeared; background/panel measure end-to-end from here
  show(job.title, "…", "Analyzing job…");
  chrome.runtime.sendMessage({ type: "score", job }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      setTimeout(() => { scored = ""; }, 15000); // allow a retry (e.g. after fixing Settings) without hammering the API
      return show(job.title, "!", res?.error || "Could not reach extension");
    }
    console.log(`[Jev] floating box shown ${Date.now() - seenAt}ms after detection`);
    const { score, tier, meetsRequirements } = res.r;
    show(job.title, score, `${tier ?? ""} · Meets core requirements: ${meetsRequirements ? "yes" : "no"}`, color(score));
  });
}

// React to page changes instead of polling. Throttled (not debounced) because LinkedIn mutates constantly.
const SETTLE_MS = 250;
let pending;
function schedule(ms) {
  if (pending) return;
  pending = setTimeout(() => { pending = 0; tick(); }, ms);
}
const observer = new MutationObserver(() => schedule(SETTLE_MS));
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
console.log("[Jev] content script loaded");
tick(); // job may already be on screen when the script loads
