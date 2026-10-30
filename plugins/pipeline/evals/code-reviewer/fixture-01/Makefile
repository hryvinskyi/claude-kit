lint:
	@find packages bin -name '*.php' -print0 | xargs -0 -n1 php -l

test:
	@for t in packages/shop/tests/Unit/*.php packages/shop/tests/Integration/*.php; do php "$$t" || exit 1; done
