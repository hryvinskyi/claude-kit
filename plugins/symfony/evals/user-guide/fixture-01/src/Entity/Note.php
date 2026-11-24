<?php

declare(strict_types=1);

namespace Acme\Notes\Entity;

/**
 * A note and the member who wrote it.
 */
class Note
{
    public function __construct(private readonly int $id, private string $title, private readonly int $authorId)
    {
    }

    public function getId(): int
    {
        return $this->id;
    }

    public function getTitle(): string
    {
        return $this->title;
    }

    public function getAuthorId(): int
    {
        return $this->authorId;
    }
}
