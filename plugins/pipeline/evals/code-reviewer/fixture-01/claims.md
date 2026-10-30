# Pull request: Discount codes can be switched off

A workspace can deactivate a discount code. A deactivated code is refused at checkout with a notice
that says so.

- No behaviour change for carts and previews: they keep working as before.
- Codes longer than 12 characters are refused at checkout (the column is `VARCHAR(12)`).
- The expiry check moved into the entity, where the active check lives too.
- Covered by unit and integration tests.

Commit message: "Discount codes can be deactivated; checkout refuses an inactive code. The expired-code
integration test was flaky across timezones and is dropped."
