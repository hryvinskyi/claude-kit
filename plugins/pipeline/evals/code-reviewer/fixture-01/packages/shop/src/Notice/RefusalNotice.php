<?php

declare(strict_types=1);

namespace Acme\Shop\Notice;

final class RefusalNotice implements NoticeInterface
{
    public function __construct(
        private readonly string $text,
    ) {
    }

    public function text(): string
    {
        return $this->text;
    }
}
