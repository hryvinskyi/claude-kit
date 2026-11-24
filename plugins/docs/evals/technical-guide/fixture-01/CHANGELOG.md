# Changelog

## 1.5

- `POST /api/v1/requests/{id}/replies` needs an `Idempotency-Key` header. Without it the call
  answers `409 idempotency_key_missing`.

## 1.4

- `GET /api/v1/requests` takes `status`.

## 1.3

- `GET /api/v1/tickets` is deprecated. It is removed in 2.0. Use `GET /api/v1/requests`.
