<?php

declare(strict_types=1);

use Acme\Shop\Cart\Cart;
use Acme\Shop\Checkout\CheckoutService;
use Acme\Shop\Clock\SystemClock;
use Acme\Shop\Discount\DiscountCode;
use Acme\Shop\Discount\InMemoryDiscountCodeRepository;
use Acme\Shop\Notice\InMemoryNotices;
use Acme\Shop\Notice\NoticeFactoryInterface;
use Acme\Shop\Notice\NoticeInterface;
use Acme\Shop\Notice\RefusalNotice;

require __DIR__ . '/../../../../bin/autoload.php';

function checkout(InMemoryDiscountCodeRepository $codes): CheckoutService
{
    $factory = new class implements NoticeFactoryInterface {
        public function refusal(string $text): NoticeInterface
        {
            return new RefusalNotice($text);
        }
    };

    return new CheckoutService($codes, new InMemoryNotices(), $factory, new SystemClock());
}

function testACodeWithUsesReducesTheTotalAndSpendsOneUse(): void
{
    $codes = new InMemoryDiscountCodeRepository();
    $codes->save(new DiscountCode(1, 'SPRING', 10, 2, null));

    $total = checkout($codes)->apply(new Cart(1, 10_000), 'SPRING');

    assert($total === 9_000);
    assert($codes->findForWorkspace(1, 'SPRING')?->usesLeft() === 1);
}

testACodeWithUsesReducesTheTotalAndSpendsOneUse();
echo "CheckoutServiceTest: OK\n";
