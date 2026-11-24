<?php

declare(strict_types=1);

namespace Acme\Desk;

/**
 * The signed-in person: one role, and everything that role may do.
 */
class Viewer
{
    /**
     * @param array{hierarchy: array<string, list<string>>, screens: array<string, array{role: string, menu: list<string>}>, actions: array<string, string>} $access
     */
    public function __construct(private readonly string $role, private readonly array $access)
    {
    }

    /**
     * Whether this person holds the given role, directly or through a role that includes it.
     */
    public function is(string $role): bool
    {
        if ($this->role === $role) {
            return true;
        }

        foreach ($this->access['hierarchy'][$this->role] ?? [] as $included) {
            if ((new self($included, $this->access))->is($role)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Whether this person may take the given action.
     */
    public function can(string $action): bool
    {
        return isset($this->access['actions'][$action]) && $this->is($this->access['actions'][$action]);
    }

    /**
     * Whether this person may open the given screen. A screen they may not open is left out of their menu.
     */
    public function opens(string $screen): bool
    {
        return isset($this->access['screens'][$screen]) && $this->is($this->access['screens'][$screen]['role']);
    }
}
