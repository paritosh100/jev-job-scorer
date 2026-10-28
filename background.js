const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Mirrors the Role Fit Map (job-fit-analysis-tier-rank skill): points 6-10 scored individually,
// then an overall tier choice. No prose — systemone only returns scores/choices/probabilities.
const PROOF_LEVELS = [
  "Missing proof: no relevant project, achievement, or experience shown",
  "Weak proof: tangential or unclear evidence, not a real match",
  "Adjacent proof: relevant but in a different context or much smaller scope",
  "Transferable proof: clearly relevant work, though context or scale differs from this role",
  "Direct proof: clearly did this work, in a similar enough context and scale",
];
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
  hard_skills: {
    type: "score",
    instructions: "How strongly the resume evidences the job's essential hard skills, tools, systems, and methods (Role Fit Map point 6).",
    criteria: ["Missing", "Weak", "Partial", "Good", "Strong"],
  },
  soft_skills: {
    type: "score",
    instructions: "How strongly the resume evidences the stakeholder management, communication, leadership, and judgement this role expects (Role Fit Map point 7).",
    criteria: ["Missing", "Weak", "Partial", "Good", "Strong"],
  },
  responsibilities: {
    type: "score",
    instructions: "How well the resume shows the candidate has done both the standard and role-specific responsibilities of this job (Role Fit Map points 4-5).",
    criteria: ["Missing", "Weak", "Partial", "Good", "Strong"],
  },
  industry_fit: {
    type: "score",
    instructions: "How well the resume matches what a recruiter would screen for in the first 10 seconds: industry, domain, business model, seniority, company type (Role Fit Map point 8).",
    criteria: ["Missing", "Weak", "Partial", "Good", "Strong"],
  },
  expected_proof: {
    type: "score",
    instructions: "Whether the resume shows the 3-5 projects, wins, or experiences a credible candidate would be expected to show for this role (Role Fit Map point 9). Do not credit keywords without evidence.",
    criteria: PROOF_LEVELS,
  },
  scale_transferability: {
    type: "score",
    instructions: "Whether the candidate's proof was done at a similar enough scale, context, and complexity to what this role requires: data/user volume, business pressure, ownership level, production/real-world use (Role Fit Map point 10).",
    criteria: [
      "Not transferable: far below the scale/context this role requires",
      "Weakly transferable: smaller scale or very different context",
      "Partially transferable: some gaps in scale or context",
      "Mostly transferable: minor gaps in scale or context",
      "Fully transferable: similar enough scale and context",
    ],
  },
  tier: {
    type: "choice",
    instructions: "The overall Role Fit Tier for this candidate, following the job-fit-analysis-tier-rank framework: Tier 1 needs 3-5 direct proof points at a similar scale; Tier 2 needs strong core alignment but a context gap; Tier 3 has only 1-2 relevant proof points; Tier 4 lacks the expected proof or fails a hard constraint.",
    criteria: {
      "Tier 1 - top fit": "3-5 direct proof points, similar enough scale and context, obvious fit",
      "Tier 2 - good transferable fit": "Strong core alignment with one or more context gaps to explain",
      "Tier 3 - crossover/adjacent fit": "Only 1-2 relevant proof points, partial or indirect evidence",
      "Tier 4 - not enough fit": "Missing expected proof, essential skills, or fails a hard constraint",
    },
  },
  meets_requirements: {
    type: "noul",
    instructions: "The candidate meets the job's core required qualifications (not just nice-to-haves).",
  },
  hard_constraints_ok: {
    type: "noul",
    instructions: "The candidate's resume does not conflict with any hard constraint stated in the job (location, work authorisation, required certification, minimum years of experience, seniority).",
  },
};
const LEVELS = QUESTIONS.relevance.criteria.length - 1;
const DIMENSIONS = ["hard_skills", "soft_skills", "responsibilities", "industry_fit", "expected_proof", "scale_transferability"];

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
  if (answers?.relevance?.score == null || DIMENSIONS.some((d) => answers[d]?.score == null)) throw new Error("Unexpected Jev response shape");
  const breakdown = Object.fromEntries(DIMENSIONS.map((d) => [d, {
    score: Math.round((answers[d]?.score / (QUESTIONS[d].criteria.length - 1)) * 100) / 10,
    confidence: answers[d]?.confidence,
  }]));
  // tier and hard_constraints_ok are scored independently by the API, so the tier answer can
  // ignore a failed hard constraint even though its own instructions mention one. The skill's
  // decision rule 5 treats a hard-constraint miss as an override, not a vote, so we enforce it here.
  const hardConstraintsOk = answers.hard_constraints_ok?.noul >= 0.5;
  const result = {
    score: Math.round((answers.relevance.score / LEVELS) * 100) / 10,
    tier: hardConstraintsOk ? answers.tier?.choice : "Tier 4 - not enough fit",
    tierConfidence: hardConstraintsOk ? answers.tier?.confidence : 1,
    meetsRequirements: answers.meets_requirements?.noul >= 0.5,
    hardConstraintsOk,
    breakdown, // per Role-Fit-Map dimension: hard_skills, soft_skills, responsibilities, industry_fit, expected_proof, scale_transferability
    title: job.title || "",
    company: job.company || "",
    url: job.url || "",
    publishedAt: job.publishedAt || "",
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

// Ashby's JSON-LD can render after content.js already scored the job text, so the first score() call
// can miss publishedAt. content.js re-sends it here once it shows up, patching the cache + `current` in place.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "updatePublishedAt") return;
  (async () => {
    const { resume, scores = {}, current } = await chrome.storage.local.get(["resume", "scores", "current"]);
    if (!resume) return;
    const key = await hash(resume + "\n" + (msg.text || "").slice(0, 20000));
    if (scores[key]) {
      scores[key] = { ...scores[key], publishedAt: msg.publishedAt };
      await chrome.storage.local.set({ scores });
    }
    if (current && !current.pending) await chrome.storage.local.set({ current: { ...current, publishedAt: msg.publishedAt } });
  })();
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
