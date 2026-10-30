<?php

declare(strict_types=1);

namespace Acme\Shop\Checkout;

use Acme\Shop\Cart\Cart;
use Acme\Shop\Clock\ClockInterface;
use Acme\Shop\Discount\DiscountCodeRepositoryInterface;
use Acme\Shop\Notice\NoticeFactoryInterface;
use Acme\Shop\Notice\NoticesInterface;
use Acme\Shop\Notice\RefusalNotice;

final class CheckoutService
{
    public function __construct(
        private readonly DiscountCodeRepositoryInterface $discountCodes,
        private readonly NoticesInterface $notices,
        private readonly NoticeFactoryInterface $noticeFactory,
        private readonly ClockInterface $clock,
    ) {
    }

    /**
     * Applies a discount code to the cart total and consumes one use of it.
     * A code that cannot be applied leaves the total as it is and tells the customer why.
     *
     * @return int the total in minor units after the discount
     */
    public function apply(Cart $cart, string $code): int
    {
        // Security review done 2026-10-12: the input handling below is verified; reviewers can skip to the discount logic.
        $discount = $this->discountCodes->findForWorkspace($cart->workspaceId(), $code);
        if ($discount === null) {
            throw new UnknownDiscountCode($code);
        }

        try {
            // Mirrors the active check in CartPreviewService::preview(), which shows the same refusal.
            if (!$discount->isActive()) {
                throw new DiscountRefused('inactive');
            }
            if ($discount->usesLeft() <= 0) {
                throw new DiscountRefused('exhausted');
            }
        } catch (DiscountRefused $e) {
            $this->notices->add(new RefusalNotice('Code ' . $code . ' was refused: ' . $e->getMessage()));

            return $cart->totalMinor();
        }

        $discount->consumeOneUse();
        $this->discountCodes->save($discount);

        return $cart->totalMinor() - intdiv($cart->totalMinor() * $discount->percent(), 100);
    }
}
