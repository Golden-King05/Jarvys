# Point tag glossary

Reference for the `key`/`value` tags a saved [`Point`](../../server/src/db.ts) can carry
(the `PointTag` shape used by `propose_map_point`, the tag editor, and
`point-tags.xlsx` in this folder). Each tag below lists its accepted values —
a fixed set, or a format pattern — separated by `;` in the spreadsheet.

**A single point's tag can itself hold more than one of those values at
once** — join them with `;`, no space before or after it (`first;registered`,
not `first; registered` or `first ; registered`). This is for when more than
one value genuinely applies to the same point at the same time (see
`brand_historic_location` below for the clearest example), not the menu of
*possible* values a tag could take — that's what the spreadsheet's own `;`
lists document.

**Two tags are the exception to underscores standing in for spaces:**
`brand` and `name` hold free text exactly as written — spaces, apostrophes,
and all (`Shake Shack`, `McDonald's`) — rather than a value from a fixed,
underscore_joined set like every other tag here.

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
one. See `military_installation` below for how `current` combines with
`amenity` to say more than just "no" about what happened to a place.

## end_date

**What it means:** The `start_date` counterpart — when the thing ended.
When a building was demolished, when an organization dissolved, when an
event (a battle, a siege) concluded. Same idea and same format as
`start_date`, just marking the other end.

**Values:** `YYYY;DD/MM/YYYY`

## building_type

**What it means:** What kind of building this is, for points where
`building` is `yes`. A more specific classification than the point's own
category/subcategory.

**Values:** `barn;house;hotel;store;apartment;office;warehouse;garage;shed;cabin;church;school;hospital;factory;restaurant;library`

This list is a starting set of common types, not exhaustive — add more as
they come up.

**Auto-fill:** Intended to be filled in automatically from the point's
category/subcategory when one of these types is recognizable there.

## military_installation

**What it means:** Marks a point as a military site or a building
belonging to one.

**Not all values here mean the same kind of thing.** Eight of the nine name
an installation *type* — this point **is** a fort, **is** an airbase, and
so on. `military_installation_structure` isn't a ninth type alongside
them; it's a different kind of answer entirely, saying this point **is
not** the installation — it's a secondary building that merely belongs to
one. Picking it doesn't compete with picking `fort` or `airbase`: a fort's
main structure gets `military_installation: fort`; its mess hall, sitting
right next to it, gets `military_installation: military_installation_structure`,
never `military_installation: fort` itself. That value alone only says
"this is *some* secondary military building" — see
`military_installation_structure` below for the separate tag that says
*which kind*.

**Values:**

- Installation types (the point itself is the installation): `fort;castle;airbase;base;camp;garrison;bunker;outpost`
- The one non-type value (the point is a secondary building, not the installation): `military_installation_structure`

**Combines with `current` and `amenity`:** `current: no` on a military
installation says it's no longer active, but not what became of the
physical structure — still standing but repurposed, or gone entirely.
`amenity: museum` (see below) resolves that: a fort with `current: no` and
`amenity: museum` is a fort that still stands and is now a museum, not an
active installation; the same fort with `current: no` and no `amenity` tag
has simply fallen — no structure, no ongoing use.

**Combines with `building`:** on a point tagged
`military_installation: military_installation_structure`, `building` is
`yes` when that secondary structure still physically stands, or `no`
(alongside `current: no`) when it's been torn down — the tag still records
that a building of that kind once stood there, even with nothing left of
it.

## military_installation_structure

**What it means:** Its own tag, not just a value — this is a deliberate
two-step process. `military_installation: military_installation_structure`
is step one: it flags a point as *some* secondary building on a military
site, not the main installation. This tag is step two: it says exactly
which kind of secondary building it is. A point isn't fully tagged as a
specific military structure until both are set; the two-step handoff is
what lets one generic flag value on `military_installation` open into a
whole breakdown of building types here, instead of needing a value on
`military_installation` for every possible kind of building on a base.

**Values:** `barracks;kitchen;mess_hall;garage;armory;watchtower;gatehouse;infirmary;stable;guardhouse`

This list is a starting set of common types, not exhaustive — add more as
they come up. Only meaningful alongside
`military_installation: military_installation_structure` on the same
point; it isn't set on its own.

## amenity

**What it means:** What a place currently functions as, when that's
different from (or in addition to) its historical purpose — right now this
only covers the museum case: a fort, castle, or similar site that's no
longer an active installation (`current: no`) but still stands and now
operates as a museum.

**Values:** `museum`

Only one value so far — more will be added as other present-day-use cases
come up.

## brand

**What it means:** The name of the chain or business a point belongs to,
when it belongs to one — a McDonald's, a Shake Shack.

**Values:** free text — the brand's real name, written exactly as the
brand writes it: spaces, apostrophes, and all (`McDonald's`, `Shake Shack`).
One of the two exceptions (with `name`) to every other tag's
underscores-for-spaces convention — there's no fixed value set to enumerate.

**Combines with `brand_historic_location`:** the two are meant to be set
together — `brand` says which chain, `brand_historic_location` (below)
says what's notable about *this* location of it.

## name

**What it means:** A point's name, as a tag rather than (or in addition to)
its own built-in name field. In practice this rarely gets set on its own —
a point already has a name, so tagging it again is mostly redundant — but
it exists for when searching or filtering by tag (`find_points_by_tag`) is
more convenient than by name directly.

**Values:** free text, the same as the point's own name. The other
exception to the underscores-for-spaces convention, alongside `brand`.

## brand_historic_location

**What it means:** What's notable about *this specific location* of a
brand — almost always set alongside `brand` (above), which says which
chain it is. Several of its values can genuinely apply to the same point
at once — see the note on combining values with `;` at the top of this
document.

**Values:**

- `first` — the first location of this brand, period. The default,
  simple case.
- `first_without_name` / `first_with_name` — a pair used instead of plain
  `first` when the brand's actual history is split across two locations:
  an owner opened an earlier business that operated almost identically but
  didn't yet carry the brand's name (tagged `first_without_name`), then
  later opened the first location that officially did (tagged
  `first_with_name`).
- `municipality` — the first location of this brand within a specific
  city/town, as opposed to the first one anywhere. Kilwins on Mackinac
  Island gets this: the first Kilwins on the island, though nowhere close
  to the first Kilwins overall.
- `registered` — the location is listed on its country's official historic
  register (the National Register of Historic Places, for the US). Set
  alongside another value here when both apply — a location that's both
  the brand's first *and* on the national registry gets
  `brand_historic_location: first;registered`.
- `unique_location` — the location has a distinctive, unusual gimmick or
  theme worth noting, independent of whether it's historically first at
  anything — a Hawaiian-themed Chick-fil-A, a location of a chain that
  normally isn't a buffet but this one is.
