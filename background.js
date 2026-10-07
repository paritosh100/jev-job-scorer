const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const QUESTIONS = {
  // score is an index into this ordered rubric (fractional); scaled to 0-10 below
  relevance: {
    type: "score",
    instructions: "How well the candidate's resume fits the job description. Weigh required skills, experience level, and domain match most heavily.",
    criteria: [
      "No fit: lacks the core skills and domain",
      "Weak fit: some overlap but missing key requirements",
      "Moderate fit: meets some core requirements",
      "Strong fit: meets most core requirements",
      "Ideal fit: meets all core requirements and domain",
    ],
  },
  tier: {
    type: "choice",
    instructions: "The overall fit tier of this candidate for the job.",
    criteria: {
      "Tier 1 - perfect fit": "Meets essentially all requirements and domain",
      "Tier 2 - strong fit": "Meets most requirements",
      "Tier 3 - moderate fit": "Meets some requirements",
      "Tier 4 - weak fit": "Meets few requirements",
    },
  },
  meets_requirements: {
    type: "noul",
    instructions: "The candidate meets the job's core required qualifications (not just nice-to-haves).",
  },
};
const LEVELS = QUESTIONS.relevance.criteria.length - 1;

async function hash(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function callJev(apiKey, state, retry = true) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "jev-latest", state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("Could not reach Jev (network or >10s timeout)");
  }
  if ((res.status === 429 || res.status >= 500) && retry) {
    await new Promise((r) => setTimeout(r, 1500));
    return callJev(apiKey, state, false);
  }
  if (!res.ok) throw new Error(`Jev API error: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function score(job) {
  const { apiKey, resume, scores = {} } = await chrome.storage.local.get(["apiKey", "resume", "scores"]);
  if (!apiKey || !resume) throw new Error("Set your API key and resume in Settings first.");
  if (typeof job?.text !== "string" || !job.text) throw new Error("No job text");
  job.text = job.text.slice(0, 20000); // stay well inside the 32k-token state limit

  const key = await hash(resume + "\n" + job.text);
  const state = `RESUME:\n${resume}\n\nJOB DESCRIPTION:\n${job.text}`;
  if (scores[key]) return { ...scores[key], sent: job.text };
  const t0 = performance.now();
  const { answers } = await callJev(apiKey, state);
  const apiMs = Math.round(performance.now() - t0); // includes the retry delay if one happened
  if (answers?.relevance?.score == null) throw new Error("Unexpected Jev response shape");
  const result = {
    score: Math.round((answers.relevance.score / LEVELS) * 100) / 10,
    tier: answers.tier?.choice,
    meetsRequirements: answers.meets_requirements?.noul >= 0.5,
    title: job.title || "",
    company: job.company || "",
    url: job.url || "",
    timestamp: Date.now(),
    apiMs,
    sent: job.text, // job description as sent (resume is constant, so not stored per job)
  };
  scores[key] = result;
  // keep newest 50
  const keep = Object.entries(scores).sort((a, b) => b[1].timestamp - a[1].timestamp).slice(0, 50);
  await chrome.storage.local.set({ scores: Object.fromEntries(keep) });
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "score", title: "Score this job", contexts: ["selection"] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); // icon click opens a panel that stays open
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let text = "…";
  try {
    const r = await score({ text: info.selectionText, url: tab.url, title: tab.title });
    text = String(r.score);
  } catch {
    text = "!";
  }
  chrome.action.setBadgeText({ tabId: tab.id, text });
});

let latest = 0; // only the newest request may write `current`
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type !== "score") return;
  const id = ++latest;
  const t0 = Date.now();
  // `current` drives the side panel, so cached results (which don't touch `scores`) still show up.
  chrome.storage.local.set({ current: { pending: true, title: msg.job?.title, company: msg.job?.company, detectedAt: msg.job?.detectedAt } });
  score(msg.job).then(
    (r) => {
      const cur = { ...r, ms: Date.now() - t0, cached: r.timestamp < t0, detectedAt: msg.job?.detectedAt, questions: QUESTIONS }; // questions are constant, so not stored per job // fresh results are stamped after t0
      console.log(`[Jev] ${cur.cached ? "cache hit" : "API call"} ${cur.ms}ms (api ${r.apiMs ?? "-"}ms): ${r.title}`);
      if (id === latest) chrome.storage.local.set({ current: cur });
      send({ ok: true, r });
    },
    (e) => { if (id === latest) chrome.storage.local.set({ current: { error: e.message, title: msg.job?.title } }); send({ ok: false, error: e.message }); });
  return true;
});
