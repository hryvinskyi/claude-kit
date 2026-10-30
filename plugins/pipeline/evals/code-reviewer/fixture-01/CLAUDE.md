# Acme Shop — repo law

A small PHP shop; modules under `packages/{module}/` (namespace `Acme\{Module}\`). No framework:
plain PHP 8.3, a Makefile, tests as plain PHP scripts. `bin/app.php` is the composition root.

## Non-negotiables

- Every PHP file: `declare(strict_types=1)`; classes `final` unless they are extension points.
- **Objects come from the container or an injected factory.** Code never writes `new` outside
  tests, `throw new …Exception` and the composition root (`bin/app.php`). A notice shown to a person
  comes from `Acme\Shop\Notice\NoticeFactoryInterface`.
- **Comment scope.** A comment or docblock describes only the unit it sits on. It never names
  another class, another module or what they do.
- **User-facing text.** A message a person reads says what happened and what to do next. It never
  carries an exception's message, a path, a host or a class name; the detail is logged.
- **Every repository read is scoped to a workspace.** A method that reads by code or id takes the
  workspace id first; `DiscountCodeRepositoryInterface::findForWorkspace()` shows the shape.
- **Tests at both levels for every behaviour change**: a unit test for the class
  (`packages/{module}/tests/Unit/`) and an integration test through the wired services
  (`packages/{module}/tests/Integration/`), run by `make test`.
- Gates: `make lint` and `make test`, green before a push.
- Before a review, read `REVIEW.md` and apply its items.
