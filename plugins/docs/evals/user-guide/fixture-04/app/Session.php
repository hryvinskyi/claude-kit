<?php

declare(strict_types=1);

namespace Acme\Desk;

/**
 * Decides whether a sign-in is still good.
 */
class Session
{
    /**
     * @param array{session_hours: int, two_step: bool} $security the team's security settings
     */
    public function __construct(private readonly array $security)
    {
    }

    /**
     * Whether a sign-in made at the given time has run out.
     */
    public function expired(\DateTimeImmutable $signedInAt, \DateTimeImmutable $now): bool
    {
        return $signedInAt->modify('+' . $this->security['session_hours'] . ' hours') <= $now;
    }
}
