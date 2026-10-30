<?php

declare(strict_types=1);

namespace Acme\Shop\Http;

use Acme\Shop\Discount\DiscountCodeRepositoryInterface;

final class DiscountController
{
    public function __construct(
        private readonly DiscountCodeRepositoryInterface $discountCodes,
    ) {
    }

    /**
     * Handles POST /discount/deactivate?code=… and answers with the page fragment to show.
     *
     * @param array<string, string> $query the query string, decoded
     */
    public function deactivate(array $query): string
    {
        $code = $query['code'] ?? '';
        $discount = $this->discountCodes->findByCode($code);
        if ($discount === null) {
            return '<p>Unknown code.</p>';
        }

        $discount->deactivate();
        $this->discountCodes->save($discount);

        return "<p>Discount code {$code} is now inactive.</p>";
    }
}
