# Redemption Options

The approved values for each redemption item — t-shirt, volunteer t-shirt, meal, drink, lunch — and
how the attendee editor enforces them.

Written for whoever edits the list, loads the roster or runs the admin desk on the night.

Companion documents:

- [`deployment.md`](../operations/deployment.md#operations): adding walk-ins and editing attendees in
  `/admin/attendees`
- [`data-retention.md`](../security/data-retention.md): what the entitlement columns hold and when they
  go
- [`survey.md`](./survey.md#the-questions-files): the questionnaire files this one is modelled on

---

## What this does

`/admin/attendees` offers each item as a dropdown instead of a text field. The choices are
**Sem direito** (not entitled) followed by the approved values for that item **for the record's
role**, in file order. Changing the role in the form rebuilds the dropdowns for the new one.

The value chosen is stored **exactly as written in the file** in `meal_option`, `drink_option`,
`tshirt_size`, `tshirt_volunteer_size` or `lunch_option`, and shown verbatim on the attendee's pass, the volunteer's scan screen, the roster
and the results export. There is no code-to-label mapping: the value is the label.

On the attendee's pass, a collected item stays marked `retirado` for one hour after redemption
and then leaves the chip list. Undoing the redemption brings it back as `a retirar` — from the
attendee's record on `/admin/redemptions` (`redemptions:write`), which audits the undo with a reason,
or in a rehearsal by clearing its `*_redeemed_at` as the migrator.

## The file

`src/web/content/redemption-options.md`. It is not under a locale directory, because the values
are stored data rather than translatable copy.

An edit is a commit and a redeploy. The file is parsed once at boot by
`src/modules/admin/admin.item-options.ts`, and **a malformed file stops the app from booting**.
`npm run redemption:check`, part of `npm run check`, runs the same parse and lists every problem
at once.

### Grammar

```md
<!--
  Editing notes live in HTML comments, which are ignored.
-->

# Opções de retirada

## tshirt

- P - Preto
- M - Preto

## tshirt_volunteer

- M - Roxa

## meal

- Água de boas-vindas

### participant

- Hambúrguer de Carne

### volunteer

- 17h15

## drink

- Água com gás

## lunch

- Almoço
```

- An optional `#` title, then exactly one `##` section per item. The heading is the item's key —
  `tshirt`, `tshirt_volunteer`, `meal`, `drink` or `lunch` — not its label. Sections may be in any
  order; all five are required.
- Each section holds one bulleted list and nothing else. Each bullet is one option.
- An option is a single line of plain text, at most 60 characters. No emphasis, links, task boxes
  or backslash escapes: they would be stored as their Markdown source.
- An option may appear only once in its section.
- A section may split its options by role. An optional untagged list comes first and applies to
  every role; then a `### participant` and a `### volunteer` subsection, each with exactly one
  bulleted list. A role's dropdown is the untagged list followed by that role's subsection. In the
  example, participants choose between *Água de boas-vindas* and *Hambúrguer de Carne*, volunteers
  between *Água de boas-vindas* and *17h15*.
- A value appears once per section across its subsections: to offer it to both roles, put it in
  the untagged list.
- `### participant` is refused under `tshirt_volunteer` and `lunch`, which participants never hold
  ([below](#volunteer-only-items)). `### volunteer` is allowed there but redundant.
- An unknown subsection name, a repeated one, or a subsection without a list is an error.

### Editing rules

- **Adding** an option is always safe.
- **Renaming or removing** an option does not touch existing records. Anyone already holding the
  old value keeps it, and the editor shows it as off-list (below). Rename before the roster is
  loaded, or run the query below afterwards and correct the stragglers.
- **Moving** a value from one role's subsection to the other's behaves like a rename or removal
  for records of the role that lost it: they keep it as off-list until the role changes or the
  value is replaced.
- Order is the dropdown's order. Put the common choice first.

## Volunteer-only items

Some volunteers are given lunch and a volunteer t-shirt; no participant ever is. The volunteer
t-shirt is a separate item from `tshirt`, so a volunteer may hold both. `lunch_option` and
`tshirt_volunteer_size` are refused on a participant in three places:

- **The database.** `attendees_lunch_volunteer_check` (migration 026) and
  `attendees_tshirt_volunteer_volunteer_check` (migration 028) reject any row with a participant
  role and a value, whichever statement writes it.
- **The editor.** Saving either on a participant is refused with `volunteerOnlyItem`. To turn a
  volunteer holding one into a participant, clear it first; a collected item cannot be cleared.
- **The roster import.** A participant row with either column set is a problem, and the file does
  not load.

A participant's staff card leaves both rows out, since they could only ever say *Sem direito*.
Volunteers without one see it as *Sem direito*, like any other item. The list of volunteer-only
items is `VOLUNTEER_ONLY_ITEMS` in `src/constants/pass.ts`.

## The T-shirt desk

`/admin/tshirts` (scope `tshirt:redeem`) hands over the purchased `tshirt` and nothing else:
`tshirt_volunteer` is never listed or redeemable there. Anyone with a `tshirt_size` is included,
volunteers who bought a shirt among them, and the size shown is the stored value verbatim. The
hand-over goes through the same `redeemItem` as the counter, recorded as `actor_type = 'admin'`
with outcome `redeemed` (or `duplicate` on a repeat) and no reason. The attendee's pass shows
`retirado` as for any collection, and the redemptions history lists the row under the
administrator's username. There is no undo on the desk; correct it on `/admin/redemptions`. See
[`admin-scopes.md`](./admin-scopes.md#tshirtredeem).

## Off-list values

The roster is imported outside this application, so a record can hold a value the list does not.
A value is off-list when it is not approved **for the record's role**: a participant's meal that
appears only under `### volunteer` is off-list, though it is on the file.

The editor handles that without forcing a change:

- The stored value stays **selected**, labelled `<value> (fora da lista)`.
- Saving the record **without touching that item** keeps the value, but only while the role is
  unchanged. The service accepts a value that is on the role's list or identical to what is already
  stored under the same role.
- Choosing another option replaces it, and the off-list choice is gone on the next load.
- On a **role change** the form clears an item whose value the new role lacks, back to *Sem
  direito*, and restores it if the role is switched back before saving. The stored off-list value
  is not carried over.
- A request that sends any other off-list value, including a stored one under a changed role, is
  refused with `optionNotAllowed`.

A collected item's **Sem direito** choice is disabled: clearing an entitlement that has already
been handed over would contradict the `redemptions` audit trail, and the server refuses it with
`itemAlreadyRedeemed` regardless.

**Collected, then a role change.** The role locks at check-in, but redemption does not require
one: the T-shirt desk and the counter both record through `redeemItem`, which does not check it. A
record can therefore hold a collected item while its role is still editable. If that item is
role-scoped (today, `meal` and `drink`) and the new role lacks the collected value, the form falls back to
**Sem direito** as for any other item, and the save is refused with `itemAlreadyRedeemed`. Nothing
is written. Switch the role back, or undo the redemption on `/admin/redemptions` first if the role
really is wrong. An item with no role subsections (today, `tshirt`) is never affected.

### Finding off-list records

Run after loading the roster, and again after any rename or role move. It reads the deployed
list, so it always matches what the editor offers: each record is checked against the options of
its own role.

```bash
docker compose exec -T -e LOG_LEVEL=silent app node --input-type=module -e "
const { ITEM_OPTIONS_BY_ROLE } = await import('./src/modules/admin/admin.item-options.ts');
const { default: pg } = await import('./src/shared/db/postgres.ts');
const { env } = await import('./src/config/env.ts');
const columns = {
  tshirt: 'tshirt_size', tshirt_volunteer: 'tshirt_volunteer_size',
  meal: 'meal_option', drink: 'drink_option', lunch: 'lunch_option',
};
const { rows } = await pg.query(
  'SELECT ticket_code, attendee_role, ' + Object.values(columns).join(', ') +
  ' FROM attendees WHERE event_id = \$1', [env.eventId]);
const offList = rows.flatMap((row) =>
  Object.entries(columns)
    .filter(([item, column]) =>
      row[column] !== null &&
      ITEM_OPTIONS_BY_ROLE[row.attendee_role][item].includes(row[column]) === false)
    .map(([item, column]) => ({
      ticket_code: row.ticket_code, role: row.attendee_role, item, value: row[column] })));
console.table(offList);
process.exit(0);"
```

No rows means every record is on the list. Otherwise, correct each one in `/admin/attendees` — or,
for a whole batch from the same import mistake, with one `UPDATE` as `pelicanpass_migrator`.

## Code map

| Path                                            | Role                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `src/web/content/redemption-options.md`         | The list                                          |
| `src/modules/admin/admin.item-options.ts`       | Parser, `ITEM_OPTIONS`, `ITEM_OPTIONS_BY_ROLE`, `optionsFor`, `isApprovedOption` |
| `scripts/redemption/check.ts`                   | `npm run redemption:check`                        |
| `src/modules/admin/admin.attendees.rules.ts`    | `readOption`: the list-or-unchanged rule          |
| `src/web/client/pages/admin/attendees/form/role-options.ts` | Rebuilds the dropdowns on a role change |
| `src/web/views/pages/admin/attendees/form.ejs`  | The dropdowns                                     |
| `scripts/db/seed.ts`                            | Seeds entitlements from the same list             |
| `migrations/026_lunch-item.ts`                  | Lunch columns and the volunteer-only check        |
