<?php

declare(strict_types=1);

/**
 * Every error the API answers with: status, code, what it means.
 */
return [
    [401, 'token_missing', 'The Authorization header is missing.'],
    [401, 'token_invalid', 'The token is unknown or was revoked.'],
    [403, 'scope_missing', 'The token may not make this call.'],
    [404, 'not_found', 'No such request in this team.'],
    [409, 'idempotency_key_missing', 'A reply needs an Idempotency-Key header.'],
    [422, 'validation_failed', 'A parameter or the body is not valid. The answer names the field.'],
    [429, 'rate_limited', 'Too many calls. The Retry-After header gives the seconds to wait.'],
    [500, 'server_error', 'Something failed on our side. The answer carries a request_id.'],
];
