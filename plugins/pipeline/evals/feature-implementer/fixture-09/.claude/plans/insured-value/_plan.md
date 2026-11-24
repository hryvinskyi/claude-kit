# Plan — an insured value on a quote

Level: M. A sender may declare what a parcel is worth. Insurance is free up to a value of 100; above
it the quote grows by 1% of the declared value. This plan puts the declared value into the quote;
the booking follows in a task of its own.

## Decisions

- The declared value arrives as `insuredValue`, beside `weight`, `longestSide` and `express`, in the
  same request body. A body with no `insuredValue` asks for no insurance.
- Insurance is not carriage: express multiplies the carriage and the oversize fee, never the
  insurance.
- The weight's refusals come before the value's: a parcel that is too heavy is refused as too heavy,
  whatever it is worth.
- A booking takes no insured value yet (Task 3).

## Acceptance criteria

- **AC-1** — Given a parcel with a declared value of 100 or less, or with none, when it is quoted,
  then the price is the carriage alone: a parcel of 2 kg with a declared value of 100 costs 6.5.
- **AC-2** — Given a declared value above 100, when the parcel is quoted, then 1% of the declared
  value is added to the price, and the price is rounded to the cent: a parcel of 2 kg with a declared
  value of 133.33 costs 7.83.
- **AC-3** — Given an express parcel of 2 kg with a declared value of 1000, when it is quoted, then
  the price is 19.75: express multiplies the carriage (6.5 × 1.5 = 9.75), and the insurance (10) is
  added after it.
- **AC-4** — Given a declared value above 5000, when the parcel is quoted, then the quote is refused
  with the reason `value_too_high`. A declared value of exactly 5000 is insured.
- **AC-5** — Given a declared value that is below 0 or is not a finite number (a text, `null`,
  `Infinity`), when the parcel is quoted, then the quote is refused with the reason `value_invalid`.
- **AC-6** — Given a sender on the quote page (`POST /quotes`), when they ask for a quote of a parcel
  of 2 kg with a declared value of 1000, then the page answers the price 16.5; and when the declared
  value is 6000, the page answers 422 with the reason `value_too_high` and its wording in the
  reader's language.

## Tasks

| # | Task | AC | Test level | Impl | Depends on |
|---|------|----|-----------|------|-----------|
| 1 | Refusal reasons are registered, and one check words them all (`QUOTE_REASONS`, `POSTCODE_REASONS`, `tests/unit/messages.test.js`) — done | — | unit | session | — |
| 2 | The insured value in the quote | AC-1, AC-2, AC-3, AC-4, AC-5, AC-6 | unit + integration | sonnet — extends one pure function | 1 |
| 3 | A booking carries the insured value | — | — | sonnet | 2 |

### Task 2 — the insured value in the quote

Extend `quote` in `src/quote.js`: `quote({ weight, longestSide, express, insuredValue })` → the price.

- Insurance is free up to a declared value of 100, and costs 1% of a higher one. The highest value
  insured is 5000. The price is rounded to the cent after the insurance is added.
- Register the two new reasons in `QUOTE_REASONS`: `value_too_high` and `value_invalid`.
- Word them in `src/messages/en.js` and `src/messages/de.js`:
  - `value_too_high` — en `We insure parcels up to a value of 5000.`, de
    `Wir versichern Pakete bis zu einem Wert von 5000.`
  - `value_invalid` — en `Enter the parcel's value as a number, 0 or more.`, de
    `Geben Sie den Wert des Pakets als Zahl ab 0 an.`
- `src/handlers.js` and `src/app.js` do not change: the quote route hands the request's body to
  `quote` as it is, and a `QuoteRefused` is already answered 422 with its reason and its wording.
- It delivers AC-1, AC-2, AC-3, AC-4, AC-5 and AC-6.

Its tests go in `tests/unit/quote.test.js` and `tests/integration/quotes.test.js`, beside the tests
that are there, and run with `npm test`. Do not touch any other file.

### Task 3 — a booking carries the insured value

Not started: it waits for Task 2.
