# Engineering standards on Symfony

The engineering standards name no framework. On a Symfony project these are the spellings they
mean, and they bind as the standards do.

## Architecture and tech debt on Symfony
- **Code is written clean, always.** The bar is also stated by the `symfony:symfony-architecture-php` skill and, for the browser code Symfony ships — Stimulus controllers and the scripts its asset pipeline serves — by the `symfony:symfony-architecture-frontend` skill.
- **Debt is fixed through the rubric, not from memory.** The stack skill is `symfony:symfony-architecture-php` beside `architecture:clean-architecture-php`, and `symfony:symfony-architecture-frontend` beside `architecture:clean-architecture-js`.
- **A module names only what it depends on.** A package declares its dependencies in its `composer.json` require (and its `package.json` for browser code); the framework adds no module manifest of its own.

## Tests run code on Symfony
- Parsing `services.yaml` in a test is reading a project file and asserting its structure.
- The build step that compiles the container and proves the wiring is the container compile.
