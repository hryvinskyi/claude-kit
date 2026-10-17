<?php

declare(strict_types=1);

namespace Acme\Billing\Api;

use Acme\Billing\Entity\Invoice;

interface InvoiceRepositoryInterface
{
    /** @throws InvoiceNotFound */
    public function get(string $id): Invoice;

    public function save(Invoice $invoice): void;
}
