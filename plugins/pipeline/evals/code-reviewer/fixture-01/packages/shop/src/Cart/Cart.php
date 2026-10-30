<?php

declare(strict_types=1);

namespace Acme\Shop\Cart;

final class Cart
{
    public function __construct(
        private readonly int $workspaceId,
        private readonly int $totalMinor,
    ) {
    }

    public function workspaceId(): int
    {
        return $this->workspaceId;
    }

    /** The total before any discount, in minor units. */
    public function totalMinor(): int
    {
        return $this->totalMinor;
    }
}
