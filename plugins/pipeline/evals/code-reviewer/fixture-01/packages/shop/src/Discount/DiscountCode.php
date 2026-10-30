<?php

declare(strict_types=1);

namespace Acme\Shop\Discount;

final class DiscountCode
{
    private bool $active = true;

    public function __construct(
        private readonly int $workspaceId,
        private readonly string $code,
        private readonly int $percent,
        private int $usesLeft,
        private readonly ?\DateTimeImmutable $expiresAt,
    ) {
    }

    public function workspaceId(): int
    {
        return $this->workspaceId;
    }

    public function code(): string
    {
        return $this->code;
    }

    public function percent(): int
    {
        return $this->percent;
    }

    public function usesLeft(): int
    {
        return $this->usesLeft;
    }

    public function expiresAt(): ?\DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function isActive(): bool
    {
        return $this->active;
    }

    /**
     * Switches the code off. Takes effect on every open cart at once: a cart holding this code
     * loses its discount on its next preview, and no new checkout can apply it.
     */
    public function deactivate(): void
    {
        $this->active = false;
    }

    public function consumeOneUse(): void
    {
        $this->usesLeft--;
    }
}
