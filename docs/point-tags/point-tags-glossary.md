# Point tag glossary

Reference for the `key`/`value` tags a saved [`Point`](../../server/src/db.ts) can carry
(the `PointTag` shape used by `propose_map_point`, the tag editor, and
`point-tags.xlsx` in this folder). Each tag below lists its accepted values —
a fixed set, or a format pattern — separated by `;` in the spreadsheet.

## start_date

**What it means:** When the thing began — the year (or exact date) a
building was built, an organization was founded, or a historical event (a
battle, say) took place. The same tag applies whether it's marking
construction or an event's date; there's no separate tag per use case.

**Values:** `YYYY;DD/MM/YYYY`

A bare four-digit year (`1886`) when that's all that's known or relevant, or
a full date in day/month/year order (`14/07/1789`) when the exact day
matters — European ordering, not month/day/year.

## building

**What it means:** Whether the point represents an actual building
structure, as opposed to a place, area, or event with no structure of its
own (a park, a battle site, a body of water).

**Values:** `yes;no`

**Auto-fill:** Set automatically when the point's category is `building` or
`hotel`.

## water_type

**What it means:** The salinity of a body of water — a lake, bay, river, or
similar — for points where that's relevant.

**Values:** `freshwater;saltwater;brackish`

## current

**What it means:** Whether the thing is presently standing / actively
happening at this location, as opposed to something historical that no
longer exists or isn't ongoing — a prehistoric or historic dwelling that
once stood here but doesn't anymore, or a battle (which, having already
happened, isn't "current" by nature).

**Values:** `yes;no`

**Default:** `yes`.

**Auto-fill:** Set to `no` automatically when the point's category is
`battle`, since a battle is inherently a past event rather than an ongoing
one.
