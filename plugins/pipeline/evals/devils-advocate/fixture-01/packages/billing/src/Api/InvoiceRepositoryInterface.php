<?php

declare(strict_types=1);

namespace Acme\Billing\Api;

use Acme\Billing\Entity\Invoice;

interface InvoiceRepositoryInterface
{
    public function get(string $id): Invoice;

    /** @return list<Invoice> all invoices not yet fully paid or credited */
    public function findAllActive(): array;

    public function save(Invoice $invoice): void;
}
