<?php

declare(strict_types=1);

namespace Acme\Shop\Discount;

final class InMemoryDiscountCodeRepository implements DiscountCodeRepositoryInterface
{
    /** @var array<string, DiscountCode> keyed by "<workspace id>:<code>" */
    private array $rows = [];

    public function findForWorkspace(int $workspaceId, string $code): ?DiscountCode
    {
        return $this->rows[$workspaceId . ':' . $code] ?? null;
    }

    public function findByCode(string $code): ?DiscountCode
    {
        foreach ($this->rows as $row) {
            if ($row->code() === $code) {
                return $row;
            }
        }

        return null;
    }

    public function save(DiscountCode $discountCode): void
    {
        $this->rows[$discountCode->workspaceId() . ':' . $discountCode->code()] = $discountCode;
    }
}
