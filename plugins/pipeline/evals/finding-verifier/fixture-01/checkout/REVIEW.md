# Review instructions — Acme Desk

## What Important means here

Critical: customer text reaches a page unescaped; one customer's ticket reaches another customer.
Important: a ticket escalated, listed or reported in the wrong state; a rule of `CLAUDE.md` broken;
a claim no code enforces; a test that pins nothing. Minor: cleanup and wording.

## Always check

1. **Every reader of a changed meaning.** When a value gains a meaning (a status, a plan, a number),
   every module that reads it is opened and read, not only grepped, including the modules the
   change does not touch.
2. **Escaping on the way out.** Every value a page prints is escaped, and nothing between the
   escape and the returned string turns it back; follow each value from its source to the page.
3. **A test pins what its name says.** For each test the change adds, say what it does when the
   behaviour it names is removed: a test that stays green then is a finding.

## Do not report

- Formatting, naming style and import order.
