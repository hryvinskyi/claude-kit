<?php

declare(strict_types=1);

namespace Acme\Billing\Entity;

final class Invoice
{
    public function __construct(
        private readonly string $id,
        private readonly string $number,
        private readonly string $paymentMethod,
        private int $totalMinor,
        private readonly string $currency,
    ) {
    }

    public function id(): string
    {
        return $this->id;
    }

    /** Assigned once at issue time; immutable afterwards (see kb/Decisions). */
    public function number(): string
    {
        return $this->number;
    }

    public function paymentMethod(): string
    {
        return $this->paymentMethod;
    }

    public function totalMinor(): int
    {
        return $this->totalMinor;
    }

    public function currency(): string
    {
        return $this->currency;
    }
}
