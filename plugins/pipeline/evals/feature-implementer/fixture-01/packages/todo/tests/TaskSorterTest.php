<?php

declare(strict_types=1);

use Acme\Todo\Service\TaskSorter;

require __DIR__ . '/../src/Service/TaskSorter.php';

$sorter = new TaskSorter();
$out = $sorter->orderByWeight([
    ['title' => 'b', 'weight' => 1],
    ['title' => 'a', 'weight' => 9],
]);

assert($out[0]['title'] === 'a');
assert($out[1]['title'] === 'b');
echo "TaskSorterTest: OK\n";
