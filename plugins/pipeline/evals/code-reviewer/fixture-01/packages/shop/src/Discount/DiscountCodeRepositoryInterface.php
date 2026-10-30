<?php

declare(strict_types=1);

namespace Acme\Shop\Discount;

interface DiscountCodeRepositoryInterface
{
    public function findForWorkspace(int $workspaceId, string $code): ?DiscountCode;

    public function findByCode(string $code): ?DiscountCode;

    public function save(DiscountCode $discountCode): void;
}
