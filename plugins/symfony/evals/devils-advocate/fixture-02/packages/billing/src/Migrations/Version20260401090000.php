<?php

declare(strict_types=1);

namespace Acme\Billing\Migrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260401090000 extends AbstractMigration
{
    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE billing_invoice (
            id UUID PRIMARY KEY,
            number VARCHAR(32) NOT NULL UNIQUE,
            payment_method VARCHAR(16) NOT NULL,
            total_minor BIGINT NOT NULL,
            currency CHAR(3) NOT NULL
        )');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE billing_invoice');
    }
}
