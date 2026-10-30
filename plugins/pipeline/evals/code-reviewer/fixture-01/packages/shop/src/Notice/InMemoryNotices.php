<?php

declare(strict_types=1);

namespace Acme\Shop\Notice;

final class InMemoryNotices implements NoticesInterface
{
    /** @var list<NoticeInterface> */
    private array $notices = [];

    public function add(NoticeInterface $notice): void
    {
        $this->notices[] = $notice;
    }

    public function all(): array
    {
        return $this->notices;
    }
}
