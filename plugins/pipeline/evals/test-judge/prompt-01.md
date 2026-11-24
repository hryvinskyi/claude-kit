Stance: judge
Checkout: {{COPY}}/checkout
Tests: {{COPY}}/brief/tests.json
Gates: {{COPY}}/brief/gates.md
Levels: unit (`tests/unit/`), about a millisecond a case; integration (`tests/integration/`), which starts the application for every case — about a second each in the real deployment
Output: {{COPY}}/out/verdicts.json
Never read: .claude/plans/
