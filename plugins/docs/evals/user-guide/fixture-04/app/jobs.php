<?php

declare(strict_types=1);

/**
 * What runs without a person: the name of each job and when it runs.
 */
return [
    'archive.cleanup' => 'daily at 03:00',
    'export.build' => 'when an export is asked for',
];
