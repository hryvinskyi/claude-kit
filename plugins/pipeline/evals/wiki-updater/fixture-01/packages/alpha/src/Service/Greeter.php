<?php

declare(strict_types=1);

namespace Acme\Alpha\Service;

use Acme\Alpha\Api\GreeterInterface;

final class Greeter implements GreeterInterface
{
    private const GREETINGS = ['en' => 'Hello', 'de' => 'Hallo', 'uk' => 'Привіт'];

    public function greet(string $name, string $locale): string
    {
        $word = self::GREETINGS[$locale] ?? self::GREETINGS['en'];

        return sprintf('%s, %s!', $word, $name);
    }
}
