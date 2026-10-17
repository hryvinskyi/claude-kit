lint:
	@find packages -name '*.php' -path '*/src/*' -print0 | xargs -0 -n1 php -l

test:
	@php packages/todo/tests/TaskSorterTest.php
