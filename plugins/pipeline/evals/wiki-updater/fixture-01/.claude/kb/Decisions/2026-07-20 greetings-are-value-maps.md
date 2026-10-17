---
type: decision
status: accepted
area: alpha
---

# Greetings are value maps, not services per locale

## Decision
Locale greetings live in one constant map inside `Greeter`; unknown locales fall back to
`en`. One strategy class per locale was rejected as over-abstraction — no behavioral
variation exists beyond the word itself.
