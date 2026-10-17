# Acme Tasks — repo law

Small PHP project; modules under `packages/{module}/` (namespace `Acme\{Module}\`).

## Non-negotiables

- Every PHP file: `declare(strict_types=1)`; classes `final` unless they are extension points.
- Tests are mandatory for every behavior change (plain-PHP test scripts under
  `packages/{module}/tests/`, run by `make test`).
- Quality gates: `make lint` (php -l over src) and `make test`. Both green before handing back.
