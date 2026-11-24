<?php

declare(strict_types=1);

/**
 * Every call of the API: method and path, the scope a token needs, the parameters it reads.
 */
return [
    'GET /api/v1/requests' => [
        'scope' => 'read:requests',
        'query' => [
            'status' => ['open', 'answered', 'archived'],
            'page' => 'integer, from 1, default 1',
            'per_page' => 'integer, 1 to 100, default 25',
        ],
    ],
    'GET /api/v1/requests/{id}' => [
        'scope' => 'read:requests',
    ],
    'POST /api/v1/requests/{id}/replies' => [
        'scope' => 'write:replies',
        'headers' => ['Idempotency-Key' => 'required from 1.5; a repeated key answers with the first reply'],
        'body' => ['text' => 'string, 1 to 10000 characters'],
    ],
    'GET /api/v1/tickets' => [
        'scope' => 'read:requests',
        'deprecated' => ['since' => '1.3', 'removed_in' => '2.0', 'use' => 'GET /api/v1/requests'],
    ],
];
