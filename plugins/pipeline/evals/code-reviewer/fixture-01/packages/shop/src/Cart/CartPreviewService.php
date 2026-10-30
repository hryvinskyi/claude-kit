<?php

declare(strict_types=1);

namespace Acme\Shop\Cart;

use Acme\Shop\Discount\DiscountCodeRepositoryInterface;

final class CartPreviewService
{
    public function __construct(
        private readonly DiscountCodeRepositoryInterface $discountCodes,
    ) {
    }

    /**
     * Shows the total a code would give before the checkout.
     *
     * @return int the total in minor units, discounted when the code applies
     */
    public function preview(Cart $cart, string $code): int
    {
        $discount = $this->discountCodes->findForWorkspace($cart->workspaceId(), $code);
        if ($discount === null || $discount->usesLeft() <= 0) {
            return $cart->totalMinor();
        }

        $discount->consumeOneUse();
        $this->discountCodes->save($discount);

        return $cart->totalMinor() - intdiv($cart->totalMinor() * $discount->percent(), 100);
    }
}
