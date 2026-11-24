# Claims

## Pull request body

**An insured value on a quote.** A sender may declare what a parcel is worth. Insurance is free up to
a value of 100; above it the quote grows by 1% of the declared value, up to a value of 5000. Express
does not multiply the insurance. Two new refusals, `value_too_high` and `value_invalid`, are
registered and worded in both languages. The handlers and the application are untouched: the quote
route already hands the body to `quote` and already answers a refused quote.

Delivers the acceptance criteria below; `npm test` is green.

## Acceptance criteria, verbatim from the plan

- Given a parcel with a declared value of 100 or less, or with none, when it is quoted, then the
  price is the carriage alone: a parcel of 2 kg with a declared value of 100 costs 6.5.
- Given a declared value above 100, when the parcel is quoted, then 1% of the declared value is added
  to the price, and the price is rounded to the cent: a parcel of 2 kg with a declared value of
  133.33 costs 7.83.
- Given an express parcel of 2 kg with a declared value of 1000, when it is quoted, then the price is
  19.75: express multiplies the carriage (6.5 × 1.5 = 9.75), and the insurance (10) is added after
  it.
- Given a declared value above 5000, when the parcel is quoted, then the quote is refused with the
  reason `value_too_high`. A declared value of exactly 5000 is insured.
- Given a declared value that is below 0 or is not a finite number (a text, `null`, `Infinity`), when
  the parcel is quoted, then the quote is refused with the reason `value_invalid`.
- Given a sender on the quote page (`POST /quotes`), when they ask for a quote of a parcel of 2 kg
  with a declared value of 1000, then the page answers the price 16.5.

## Commit message

An insured value on a quote: free up to 100, 1% above, refused over 5000, with its unit and
integration tests
