# Contributing

Issues and pull requests are welcome.

## Setup

No build step or dependencies. Load the repo as an unpacked extension (see the README), then reload it after each change.

## Guidelines

- Keep it dependency-free plain JavaScript, and keep files small.
- Run `node --check` on any file you touch.
- Adding a job board: add its domain to `content_scripts.matches` in `manifest.json`, its description selector to `SELECTORS` in `content.js`, and, if it also serves listing pages, a URL pattern to `JOB_URL`. Please test on a real posting and attach a screenshot.
- Do not commit API keys, resumes, or screenshots of your personal accounts.

## Reporting bugs

Include the board, the job URL pattern (not your personal data), and the `[Jev]` lines from the page console.
