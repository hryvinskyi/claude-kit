<?php

declare(strict_types=1);

namespace Acme\Desk;

/**
 * Every e-mail the product sends.
 */
class Mailer
{
    /**
     * @param callable(string, string, string): void $send takes the address, the subject and the text
     */
    public function __construct(private readonly mixed $send)
    {
    }

    /**
     * The invitation a team admin sends to a colleague.
     */
    public function invitation(string $email, string $link): void
    {
        ($this->send)($email, 'You are invited to Acme Desk', $link);
    }

    /**
     * The file a team admin asked for with "Export archived requests".
     */
    public function exportReady(string $email, string $link): void
    {
        ($this->send)($email, 'Your export is ready', $link);
    }
}
