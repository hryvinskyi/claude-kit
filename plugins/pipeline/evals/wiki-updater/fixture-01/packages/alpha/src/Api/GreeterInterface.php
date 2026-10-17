<?php

declare(strict_types=1);

namespace Acme\Alpha\Api;

interface GreeterInterface
{
    /** Returns a localized greeting; falls back to "en" for unknown locales. */
    public function greet(string $name, string $locale): string;
}
