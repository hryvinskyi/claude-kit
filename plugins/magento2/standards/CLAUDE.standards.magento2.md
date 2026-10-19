# Engineering standards on Magento 2

The engineering standards name no framework. On a Magento 2 project these are the spellings they
mean, and they bind as the standards do.

## Architecture and tech debt on Magento 2
- **Code is written clean, always.** The outer concretes an inner layer never imports include the `ObjectManager`. The bar is also stated by the `magento2:magento2-architecture-php` skill and, for the browser code Magento ships — RequireJS/Knockout, Hyvä/Alpine, theme-assets scripts — by the `magento2:magento2-architecture-frontend` skill.
- **Debt is fixed through the rubric, not from memory.** The stack skill is `magento2:magento2-architecture-php` beside `architecture:clean-architecture-php`, and `magento2:magento2-architecture-frontend` beside `architecture:clean-architecture-js`. `ddd.md` is read whenever a Magento `Api/Data` type is touched.
- **No `final` classes.** Magento generates plugins (`…\Interceptor`) and proxies as subclasses of the class they wrap, so a `final` class cannot be intercepted or proxied; Magento code is never `final`, whatever the core rubric's examples show.
- **A module names only what it depends on.** The framework's module manifest is the `module.xml` sequence, which declares the same edges as the `composer.json` require.

## Tests run code on Magento 2
- Parsing `di.xml`/`config.xml`/layout XML in a test is reading a project file and asserting its structure.
- The build step that compiles the container and proves the wiring is `setup:di:compile` (`bin/magento setup:di:compile`).
