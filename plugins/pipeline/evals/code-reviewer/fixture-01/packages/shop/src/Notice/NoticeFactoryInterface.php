<?php

declare(strict_types=1);

namespace Acme\Shop\Notice;

interface NoticeFactoryInterface
{
    /** A notice that tells the customer something was refused, and what to do next. */
    public function refusal(string $text): NoticeInterface;
}
