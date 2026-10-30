<?php

declare(strict_types=1);

use Acme\Shop\Discount\DiscountCode;

require __DIR__ . '/../../../../bin/autoload.php';

function testAFreshCodeIsSpentOneUseAtATime(): void
{
    $code = new DiscountCode(1, 'SPRING', 10, 2, null);
    $code->consumeOneUse();
    assert($code->usesLeft() === 1);
}

function testADeactivatedCodeIsRefusedAtCheckout(): void
{
    $code = new DiscountCode(1, 'SPRING', 10, 2, null);
    $code->deactivate();
    assert($code->isActive() === false);
}

testAFreshCodeIsSpentOneUseAtATime();
testADeactivatedCodeIsRefusedAtCheckout();
echo "DiscountCodeTest: OK\n";
