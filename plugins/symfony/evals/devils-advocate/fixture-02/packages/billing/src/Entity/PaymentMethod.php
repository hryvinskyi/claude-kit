<?php

declare(strict_types=1);

namespace Acme\Billing\Entity;

enum PaymentMethod: string
{
    case Card = 'card';
    case Bank = 'bank';
    case StoreCredit = 'store_credit';
}
