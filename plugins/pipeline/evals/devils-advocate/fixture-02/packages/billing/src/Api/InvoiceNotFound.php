<?php

declare(strict_types=1);

namespace Acme\Billing\Api;

use RuntimeException;

final class InvoiceNotFound extends RuntimeException
{
    public function __construct(public readonly string $invoiceId)
    {
        parent::__construct('No invoice carries this id.');
    }
}
