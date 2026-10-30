<?php

declare(strict_types=1);

namespace Acme\Shop\Notice;

interface NoticesInterface
{
    public function add(NoticeInterface $notice): void;

    /** @return list<NoticeInterface> */
    public function all(): array;
}
