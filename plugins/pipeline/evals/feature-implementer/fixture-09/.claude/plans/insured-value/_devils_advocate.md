# Devil's advocate — insured value

## Constraints that survived review (binding)

1. `src/handlers.js` and `src/app.js` are not touched. The body already reaches `quote` whole, and a
   `QuoteRefused` is already answered 422 with its wording.
2. The two new reasons are registered in `QUOTE_REASONS`. No second list of reasons anywhere.
3. `src/quote.js` exports what it exports today and nothing more: `MAX_WEIGHT`, `QUOTE_REASONS`,
   `QuoteRefused` and `quote`.

## Resolved

- "Is a value of exactly 100 insured for free?" — yes; AC-1 says so.
- "Does express multiply the insurance?" — no; AC-3.
- "Which refusal wins for a parcel that is too heavy and worth too much?" — the weight's; see the
  plan's decisions.
