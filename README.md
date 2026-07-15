# paperman 🗞️

Your daily arXiv top-10, in the terminal. Made to open with your morning coffee.

```
 paperman · Wed 15 Jul
 │
 ├─ cs.LG — Machine Learning
 │  ✓ 2607.11896  OmniPMNet: Bridging discrete and gridded PM10…   cs.LG
 │    2607.11923  Latent world models transfer across embodiments   cs.LG
 │
 └─ cs.RO — Robotics
      2607.09701  EgoSteer: Steerable dexterous manipulation…      cs.RO

 ↳ closest match yet to your interest in egocentric robot learning
 ↑↓ · enter open · x cross read · g calendar · → settings · r refresh · q
```

Every day it pulls the newest papers from your tracked arXiv categories, ranks
has DeepSeek V4 Flash (via OpenRouter) pick the most relevant N per category for
your interests and goal, and freezes that list for the day.

## Install

```sh
npm install -g github:AdalricP/paperman
paperman
```

Or from a clone: `npm install && npm install -g .`, then `paperman` anywhere.
Needs Node 20+ and an [OpenRouter](https://openrouter.ai/keys) API key.

First run opens a setup screen right in the TUI — paste your API key, expand
the full arXiv category tree, check off precise categories with arrows +
space/enter, then add an interests blurb and current goal. Completed steps
collapse into the tree as you go; `esc` steps back. Everything is editable
later from the in-app settings screen.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓` (or `k`/`j`) | move selection |
| `enter` | open the paper on arxiv.org |
| `x` | cross as read (press again to unmark) |
| `g` | block a 1-hour reading session in Google Calendar |
| `→` (or `s`) | open settings |
| `←` (or `s`/`esc`) | return from settings |
| `r` | re-fetch and re-rank today's list |
| `e` | show full request diagnostics after a failure |
| `q` | quit |

Crossing a paper marks it as read in today's list and prevents it from being
picked again later. It does not affect how other papers are ranked.

## How the ranking works

1. All of today's announcements from your tracked categories are fetched from
   the official arXiv RSS feeds (`new` + cross-listed submissions only).
2. Crossed-out papers never reappear. All remaining candidates are ordered by
   recency before the OpenRouter picker considers their title, abstract,
   interests, and goal.
3. Up to twice the daily quota of top candidates per category go to the chat model (default
   `deepseek/deepseek-v4-flash` via OpenRouter) with your category, interests
   blurb, and goal. Each category request launches in parallel and reports when
   it is ready; the model picks the final N per category — "papers per category"
   in settings, default 10 — with a one-line reason each (shown in the footer).
   Titles and IDs are sent in full; abstracts are locally trimmed to 350
   characters to keep requests quick.
4. The result is frozen for the day — re-running paperman shows the same list
   with your marks. `r` forces a fresh pick.

Papers remain in a short-lived candidate pool for up to 21 days. Newer papers
are preferred, while older papers can still win when their relevance is clearly
stronger.

The first lists lean on your interests and goal, while still favoring newer
papers.

## Configuration

Everything lives in `~/.paperman` (override with `PAPERMAN_HOME`):

- `settings.json` — categories, blurbs, keys, model ids
- `daily_selection.json` — today's frozen 10 + marks
- `mark_history.json` — papers you crossed out, used only as an exclusion list
- `candidate_pool.json` — unselected recent papers, retained for soft recency
  ranking

`OPENROUTER_API_KEY` takes precedence over the stored key, and paperman also
reads it from a `.env` in the current directory or in `~/.paperman`.
`PAPERMAN_FAKE_TODAY=YYYY-MM-DD` pretends it's another day (useful for testing
the daily freeze).

## Personal Airtable log

Paperman can append every newly crossed paper to a personal Airtable base. Make
an empty base, then create a [personal access token](https://airtable.com/create/tokens)
restricted to that base with `data.records:write`, `schema.bases:read`, and
`schema.bases:write`.
Paste the token and either the base URL or its `app…` ID into the Airtable rows
in Settings. On the first crossed paper, paperman creates a `Reading Notes`
table and a linked `Pushes` table. Reading Notes has your paper name, link,
usefulness and robotics checkboxes, paper contribution, key push, and
artifact-link columns. Robotics is checked automatically for `cs.RO` papers.
Paper Contribution is generated during the normal daily model pick, so crossing
a paper does not trigger another model request.
Pressing `x` again removes the same Airtable record.

The token is a local write credential. Keep it in Settings only and do not
commit it.

## Notes

- arXiv announces new papers Mon–Fri; on weekends paperman shows the most
  recent mailing and says so in the title bar.
- The default chat model is `deepseek/deepseek-v4-flash`; its stored setting is
  intentionally not exposed in the UI.
- Settings includes a two-press hard reset that clears all local state and
  relaunches onboarding.
