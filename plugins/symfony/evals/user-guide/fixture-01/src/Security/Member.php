<?php

declare(strict_types=1);

namespace Acme\Notes\Security;

use Symfony\Component\Security\Core\User\UserInterface;

/**
 * A signed-in person of a workspace.
 */
class Member implements UserInterface
{
    /**
     * @param list<string> $roles
     */
    public function __construct(private readonly int $id, private readonly string $email, private readonly array $roles)
    {
    }

    public function getId(): int
    {
        return $this->id;
    }

    public function getRoles(): array
    {
        return $this->roles;
    }

    public function eraseCredentials(): void
    {
    }

    public function getUserIdentifier(): string
    {
        return $this->email;
    }
}
