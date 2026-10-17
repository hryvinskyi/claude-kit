<?php

declare(strict_types=1);

namespace Acme\Todo\Service;

final class TaskSorter
{
    /**
     * Orders tasks by their numeric weight, heaviest first.
     * Weights are arbitrary integers supplied by the caller; ties keep input order.
     *
     * @param list<array{title: string, weight: int}> $tasks
     * @return list<array{title: string, weight: int}>
     */
    public function orderByWeight(array $tasks): array
    {
        usort($tasks, static fn (array $a, array $b): int => $b['weight'] <=> $a['weight']);

        return $tasks;
    }
}
