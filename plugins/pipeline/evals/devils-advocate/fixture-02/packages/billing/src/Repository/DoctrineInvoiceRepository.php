<?php

declare(strict_types=1);

namespace Acme\Billing\Repository;

use Acme\Billing\Api\InvoiceNotFound;
use Acme\Billing\Api\InvoiceRepositoryInterface;
use Acme\Billing\Entity\Invoice;
use Doctrine\ORM\EntityManagerInterface;

final class DoctrineInvoiceRepository implements InvoiceRepositoryInterface
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    public function get(string $id): Invoice
    {
        return $this->em->find(Invoice::class, $id) ?? throw new InvoiceNotFound($id);
    }

    public function save(Invoice $invoice): void
    {
        $this->em->persist($invoice);
        $this->em->flush();
    }
}
