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
 ↑↓ · enter open · c done · x skip · g calendar · s settings · r refresh · q
```

Every day it pulls the newest papers from your tracked arXiv categories, ranks
them with a recommender trained on what you finished vs. dismissed, has
DeepSeek V4 Flash (via OpenRouter) pick the most relevant N per category for
your interests and goal, and freezes that list for the day.

## Install

```sh
npm install -g github:AdalricP/paperman
paperman
```

Or from a clone: `npm install && npm install -g .`, then `paperman` anywhere.
Needs Node 20+ and an [OpenRouter](https://openrouter.ai/keys) API key; a
[Fireworks](https://fireworks.ai) key is optional and unlocks the embedding
half of the recommender.

First run opens a setup screen right in the TUI — paste your API key, check
off categories with arrows + space/enter, add an interests blurb and your
current goal. Completed steps collapse into the tree as you go; `esc` steps
back. Everything is editable later from the in-app settings screen.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓` (or `k`/`j`) | move selection |
| `enter` | open the paper on arxiv.org |
| `c` | mark completed — you read it (press again to unmark) |
| `x` | cross out — not interested (press again to unmark) |
| `g` | block a 1-hour reading session in Google Calendar |
| `s` | settings: categories, interests, goal, API key, model |
| `r` | re-fetch and re-rank today's list |
| `q` | quit |

`c` and `x` are how paperman learns. Completed papers pull tomorrow's ranking
toward them, crossed-out papers push it away.

## How the ranking works

1. All of today's announcements from your tracked categories are fetched from
   the official arXiv RSS feeds (`new` + cross-listed submissions only).
2. Each candidate's title + abstract is embedded with `qwen3-embedding-8b`
   (Fireworks, optional) and scored by cosine similarity toward your completed
   papers and away from your crossed-out ones, blended with a Naive Bayes
   classifier trained on the same history. Papers you've already marked never
   reappear.
3. The top candidates per category go to the chat model (default
   `deepseek/deepseek-v4-flash` via OpenRouter) with your categories, interests
   blurb, and goal; it picks the final N per category — "papers per category"
   in settings, default 3 — with a one-line reason each (shown in the footer).
4. The result is frozen for the day — re-running paperman shows the same list
   with your marks. `r` forces a fresh pick.

On a fresh install there's no history yet, so the first lists lean on your
blurbs alone; the recommender wakes up as you mark papers.

## Configuration

Everything lives in `~/.paperman` (override with `PAPERMAN_HOME`):

- `settings.json` — categories, blurbs, keys, model ids
- `daily_selection.json` — today's frozen 10 + marks
- `mark_history.json` — your completed/crossed history (the training data)

`OPENROUTER_API_KEY` and `FIREWORKS_API_KEY` environment variables take
precedence over stored keys, and paperman also reads them from a `.env` in the
current directory or in `~/.paperman`. `PAPERMAN_FAKE_TODAY=YYYY-MM-DD`
pretends it's another day (useful for testing the daily freeze).

## Notes

- arXiv announces new papers Mon–Fri; on weekends paperman shows the most
  recent mailing and says so in the title bar.
- The default chat model is `deepseek/deepseek-v4-flash` — swap it for any
  OpenRouter model id from the settings screen.
