# Forever Watcher

Finds high-margin trades on WoW: Forever auction houses. An hourly GitHub Actions job pulls every US and EU auction house from Blizzard's Game Data API. From those snapshots it builds price history and estimates sales, then ranks flips, cross-house arbitrage and vendor flips by expected profit after fees. The results publish as a static site on GitHub Pages.

**Site:** https://morgan-webber.github.io/forever-watcher/

## How it works

| Step | What happens |
| --- | --- |
| Fetch | `GET /data/wow/ruleset/2/auctions/{houseId}` and `/commodities` for each house, using the `dynamic-forever-{us,eu}` namespace and `If-Modified-Since`. Blizzard hasn't documented these endpoints; they were mapped by players in the [Blizzard API forum](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) and in [blizzard_api's notes](https://blizzard.pinta.land/forever/auctions/). |
| Summarise | Per item: min buyout, market value (the cheapest 15% of units, outliers trimmed), percentiles, quantity listed. |
| Estimate sales | Auction IDs are followed from snapshot to snapshot. One that disappears with LONG or VERY_LONG time left counts as sold. One that disappears from SHORT or MEDIUM counts as expired. A drop in a commodity stack's quantity counts as a partial sale. This errs low on purpose. Cancelled auctions look the same as sales. |
| Score | `EV = units × relist × (1 − cut) − cost − (1/p − 1) × deposit`. Units are capped at estimated sales per day × 3 days. The relist price undercuts the cheapest listing left after your purchase. Grade A–D reflects how much history and sales data backs the estimate. |
| Backtest | Every flagged trade is checked once its 3-day horizon has passed. It's a hit if the price held at or above the relist price and estimated sales covered the units. The hit rate is shown on the site. |
| Alerts | Optional Discord webhook: top new opportunities, plus price rules in `config/alerts.json`. |

State is kept between runs in the Actions cache: price history, live auctions, item names and the backtest log. It's also backed up to the `data` branch daily and on every manual run.

## Setup

1. **Repository secrets** (Settings → Secrets and variables → Actions):
   - `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`: from https://develop.battle.net/access/clients
   - `DISCORD_WEBHOOK_URL` (optional): Discord channel → Edit → Integrations → Webhooks
2. **Pages:** Settings → Pages → Source: **GitHub Actions**.
3. **Run it:** Actions → *Collect and deploy* → *Run workflow*. After that it runs every hour.

Without Blizzard credentials, the job publishes simulated demo data, labelled as such on the site.

## What to expect in the first days

- **Hour 1:** prices and vendor flips. Item names fill in over the first few runs, up to 1,500 lookups per run.
- **After about 12 hours:** flips and arbitrage start to appear. They need a price baseline and at least 6 hours of sales tracking.
- **Day 3 onward:** the baseline switches to daily averages, grades rise, and the backtest starts reporting.

## Configuration

- `config/fees.json`: the AH cut and deposit rule. **Not yet verified for Forever.** Sell one item, read the sale mail, and correct these numbers.
- `config/settings.json`: thresholds (flip at 70% of baseline, 3-day horizon, minimum profit and ROI, minimum sales per day) and retention.
- `config/alerts.json`: Discord alert rules. Prices are in copper (1g = 10000).

House groups: each region lists 5 Alliance, 5 Horde and 5 Blackwater houses. The nth house of each faction (by ID) shares a ruleset:

| Group | Houses (A / H / Blackwater) | Ruleset |
| --- | --- | --- |
| 1 | 110 / 113 / 116 | likely PvP (large, 2nd busiest) |
| **2** | **111 / 114 / 117** | **Normal (PvE)**: confirmed by a player price match on EU; the busiest group in US |
| 3 | 112 / 115 / 118 | empty (likely reserved for Hardcore, which arrives post-launch) |
| 4 | 119 / 120 / 121 | small: likely one of the Roleplay rulesets |
| 5 | 123 / 124 / 125 | small: likely the other Roleplay ruleset |

Only group 2 is scanned by default (`settings.json → focusGroups`). To confirm in game, compare the lowest buyout of a common item on your Normal character with houses 111/114 versus 110/113.

## Local development

```sh
npm test                      # unit tests
node collector/demo.js _site  # simulate 6 days of markets and build the site
python3 -m http.server -d _site 8000
```

Requires Node 22. No npm dependencies; uPlot is vendored in `site/vendor/`.

Not affiliated with Blizzard Entertainment.
