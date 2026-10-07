# Architecture

## Components

| Part | File | Job |
| --- | --- | --- |
| Content script | `content.js` | Runs inside job pages. Finds the description, waits for it to settle, sends it to the background. |
| Service worker | `background.js` | Checks the cache, calls Jev, saves results. Holds the API key; pages never see it. |
| Storage | `chrome.storage.local` | `apiKey`, `resume`, `scores` (history/cache), `current` (job on screen), `fontScale`. |
| Side panel | `popup.html`, `popup.js` | Renders `current` and `scores`. Reads storage only. |
| Settings | `options.html`, `options.js` | Writes `apiKey` and `resume`. |
| Jev API | `api.typesafe.ai/v1/systemone` | Scores resume vs job. |

The split is forced by Chrome: content scripts run in the page's world and must not hold secrets, so they message the service worker.

## Request flow

1. A `MutationObserver` in `content.js` fires on page changes (throttled to 250 ms).
2. `read()` finds the job container (by the "About the job" heading, then per-board selectors) and extracts text, title and company.
3. New text is remembered with a timestamp (`detectedAt`) and re-checked after 250 ms. Unchanged means the page finished loading.
4. The job is sent to the service worker as `{type: "score", job}`.
5. `background.js` writes `current = {pending}`, then `score(job)`:
   - key = SHA-256(resume + job text); a hit in `scores` returns immediately, no API call
   - otherwise POST to Jev with 3 questions (10 s timeout, one retry on 429/5xx)
6. The result is saved to `scores` (newest 50 kept) and `current`, and returned to the content script for the floating box.
7. The side panel, subscribed to `storage.onChanged`, redraws.

## Jev questions

| Key | Type | Used for |
| --- | --- | --- |
| `relevance` | score (5-level rubric) | Scaled to the 0–10 score |
| `tier` | choice (4 tiers) | Tier label |
| `meets_requirements` | noul (yes/no probability) | "Meets core requirements" |

The full definitions are visible in the side panel under **Questions asked to Jev**.

## Latency

- **total** (side panel chip): first sighting of the job text to the score drawn in the panel.
- **backend**: service worker receives the request to result ready. Mostly the Jev call.
- **api_ms** (CSV): the Jev call alone, including a retry delay if one happened.

## Known limits

- Cache keys on exact text, so small page differences cause a re-score.
- `current` is global, not per tab.
- Concurrent scorings can overwrite each other's history (read-modify-write on `scores`).
- A service-worker shutdown mid-request can leave the panel on "Analyzing…".
