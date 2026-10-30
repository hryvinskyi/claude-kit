<?php

declare(strict_types=1);

namespace Acme\Shop\Notice;

interface NoticeInterface
{
    /** The sentence shown to the customer. */
    public function text(): string;
}
