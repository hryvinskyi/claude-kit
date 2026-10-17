<?php

declare(strict_types=1);

namespace Acme\Billing\Entity;

class Invoice
{
    public function __construct(
        private readonly string $id,
        private readonly string $number,
        private readonly PaymentMethod $paymentMethod,
        private readonly Money $total,
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

    public function paymentMethod(): PaymentMethod
    {
        return $this->paymentMethod;
    }

    public function total(): Money
    {
        return $this->total;
    }
}
