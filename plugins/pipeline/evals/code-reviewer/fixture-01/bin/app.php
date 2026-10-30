<?php

declare(strict_types=1);

use Acme\Shop\Cart\CartPreviewService;
use Acme\Shop\Checkout\CheckoutService;
use Acme\Shop\Clock\SystemClock;
use Acme\Shop\Discount\InMemoryDiscountCodeRepository;
use Acme\Shop\Http\DiscountController;
use Acme\Shop\Notice\InMemoryNotices;
use Acme\Shop\Notice\NoticeFactoryInterface;
use Acme\Shop\Notice\NoticeInterface;
use Acme\Shop\Notice\RefusalNotice;

require __DIR__ . '/autoload.php';

// The composition root: the one place that builds the object graph.
$discountCodes = new InMemoryDiscountCodeRepository();
$notices = new InMemoryNotices();
$noticeFactory = new class implements NoticeFactoryInterface {
    public function refusal(string $text): NoticeInterface
    {
        return new RefusalNotice($text);
    }
};
$clock = new SystemClock();

return [
    'checkout' => new CheckoutService($discountCodes, $notices, $noticeFactory, $clock),
    'preview' => new CartPreviewService($discountCodes),
    'discounts' => new DiscountController($discountCodes),
];
